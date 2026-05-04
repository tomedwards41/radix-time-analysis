# Radix Labor Analysis — CLAUDE.md

## Project Overview

Internal labor cost analysis tool for Radix IoT / enCompass. Pulls BigTime time-tracking data into Cloudflare D1 and presents monthly breakdowns across four N/C buckets (Professional Services, Radix R&D, enCompass R&D, Interco R&D Invoice). Built by Tom Edwards (tom.edwards@radixiot.com).

**Live URL:** https://dashboard.radixiot.work/labor/  
**GitHub:** https://github.com/tomedwards41/radix-time-analysis

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (SSR) |
| Framework | React Router v7 (SSR mode) |
| Database | Cloudflare D1 (SQLite edge) — two databases |
| Styling | Tailwind CSS v4 |
| Charts | ECharts via echarts-for-react |
| Language | TypeScript |
| Build | Vite |
| CI/CD | GitHub Actions → `wrangler deploy` |

---

## Deployment — CRITICAL

**There is no local Cloudflare Workers runtime.** This machine is Windows ARM64, which cannot run `workerd`. All deployments go through GitHub Actions.

**To deploy any change:**
```
git add <files>
git commit -m "..."
git push origin main
```
GitHub Actions picks up the push, runs `npm ci && npm run build && wrangler deploy` inside `web/`, and deploys to Cloudflare in ~2 minutes. Secrets `CF_API_TOKEN` and `CF_ACCOUNT_ID` live in the GitHub repo settings.

**Do NOT attempt `wrangler deploy` or `npm run dev` locally.** The build (`npm run build`) does work locally for type-checking purposes if needed.

**Workflow file:** `.github/workflows/deploy.yml`

---

## Repository Layout

```
Radix Time Analysis/           ← git root
├── .github/workflows/
│   └── deploy.yml             ← CI/CD (push main → deploy)
├── schemas/
│   ├── labor.sql              ← full D1 schema (run on fresh DB)
│   └── labor_migration_v2.sql ← upgrade path from old schema
├── import_bigtime.py          ← Python: BigTime CSV export → D1 bulk insert
├── web/                       ← the actual app
│   ├── wrangler.jsonc         ← Cloudflare config, D1 bindings, route pattern
│   ├── package.json
│   ├── app/
│   │   ├── routes.ts          ← route registry
│   │   ├── root.tsx           ← app shell + error boundary
│   │   ├── app.css            ← global styles (Tailwind + custom properties)
│   │   ├── routes/            ← one file per page
│   │   ├── components/        ← NavBar, ChartWrapper, Badge, MetricCard
│   │   └── lib/
│   │       ├── types.ts       ← all TypeScript interfaces
│   │       ├── queries.ts     ← all D1 query functions
│   │       ├── computations.ts← cost calculation logic
│   │       ├── formatters.ts  ← currency/date helpers, MONTH_LABELS
│   │       ├── excel.ts       ← Excel export generators (all 4 tabs)
│   │       ├── auth.ts        ← Cloudflare Access JWT validation
│   │       └── echarts-theme.ts
│   └── workers/app.ts         ← Cloudflare Workers entry point
```

---

## Routes

| Path | File | Purpose |
|---|---|---|
| `/` | `routes/index.tsx` | Landing page |
| `/ps` | `routes/ps.tsx` | Professional Services labor cost + journal entries |
| `/radix-rd` | `routes/radix-rd.tsx` | Radix R&D CIP (labor + Innoscale) |
| `/enc-rd` | `routes/enc-rd.tsx` | enCompass R&D CIP + 1.15× interco summary |
| `/upload` | `routes/upload.tsx` | BigTime data import + monthly override panel |
| `/roster` | `routes/roster.tsx` | Staff roster, rate history, monthly overrides |
| `/interco-rd` | `routes/interco-rd.tsx` | Detailed interco R&D invoice by feature/bucket |

To add a route: create the file, register it in `web/app/routes.ts`, add it to `NavBar.tsx`.

Each analysis tab (PS, Radix R&D, enCompass R&D, Interco R&D) has an **Export to Excel** button in the page header. See [Excel Exports](#excel-exports) section below.

---

## D1 Databases

Two databases are bound in `wrangler.jsonc`:

| Binding | Name | Purpose |
|---|---|---|
| `env.DB` | `radix_accounting` | All labor data |
| `env.AUTH` | `radix-auth` | User access control |

### Direct DB Queries (PowerShell, no deploy needed)

Use the D1 REST API to inspect or seed data directly:

```powershell
$token   = "cfut_..."   # CF_API_TOKEN from .env
$account = "58bb1cde783ed768780485e0682f3348"
$db_id   = "f676a4b3-c78f-43c2-b2e7-751251886910"

$body = @{ sql = "SELECT * FROM roster LIMIT 5" } | ConvertTo-Json
$result = Invoke-RestMethod `
  -Uri "https://api.cloudflare.com/client/v4/accounts/$account/d1/database/$db_id/query" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body $body

$result.result[0].results | Format-Table
```

The `.env` file at the repo root holds `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_DB_ID`. It is gitignored.

---

## Database Schema (`schemas/labor.sql`)

### Key tables in `radix_accounting`

**`time_entries`** — raw BigTime rows, one per person/date
- `staff_member`, `month`, `year`, `hours`, `nc_mapped` (Chargeable | Radix R&D | Enc R&D | OH)
- `labor_cost` column exists but is **never used for display** — costs are recalculated at runtime

**`roster`** — staff master (~73 people)
- `name` (UNIQUE), `emp_type` (W-2 | Sub), `dept`, `company`, `sub_category`
- `default_alloc`: `'BT'` = use BigTime hours × rate; `'100%'` = use fixed monthly rate
- `primary_nc_bucket` — for 100% people, their single bucket
- `hourly_rate`, `monthly_rate` — fallback rates if no rate history

**`roster_rate_history`** — effective-dated rates per person
- UNIQUE(name, effective_date) — most recent date ≤ month-end is used

**`monthly_overrides`** — flip behavior for specific person/month/bucket
- `use_monthly_rate` (0|1) — overrides the roster `default_alloc` for that month

**`tax_bene_rates`** — monthly W-2 tax & benefits rate (applied only to W-2 labor)

**`vendor_invoices`** — fixed monthly vendor costs
- Vendors: Innoscale ($6,055/mo), Power BI ($4,250/mo) for Enc R&D and Radix R&D
- Gated: only included in months that have actual labor

**`person_rd_allocations`** — per-person % split across 4 Interco R&D buckets
- `enc_platforms`, `data_platforms`, `reporting_bi`, `maintenance` (stored as decimals 0–1)

**`rd_features`** — feature/version list per bucket (used in Interco R&D invoice Step 2)
- `bucket`, `name`, `fixed_pct` (null for enc_platforms which uses monthly allocs), `status`, `sort_order`

**`enc_platform_allocations`** — monthly % of enc_platforms bucket per feature
- Stored as decimals 0–1; entered via admin panel on `/interco-rd`

---

## Labor Cost Calculation

All cost logic lives in `web/app/lib/computations.ts`. Never trust `time_entries.labor_cost` — it is stale.

**Rate resolution** (`resolvePersonCosts`):
1. Look up `roster_rate_history` for person — use most recent `effective_date ≤ last day of month`
2. Fallback to `roster.hourly_rate`

**Cost per person per month:**
- `default_alloc = 'BT'` → `hours × resolved_rate`
- `default_alloc = '100%'` → `173.33 × resolved_rate` (full-month equivalent)
- `monthly_overrides` can flip either direction for a specific month

**Tax & benefits:** Only W-2 employees get the tax/bene multiplier: `labor_subtotal × (1 + tax_bene_rate)`

**Vendor costs:** Gated on `subtotal_labor > 0` — Innoscale and Power BI only appear in months with actual labor.

**Interco R&D Step 1:** Per-person Enc R&D cost × 4-bucket allocation % × 1.15 markup  
**Interco R&D Step 2:** Step 1 bucket total × feature allocation % (enc_platforms uses monthly table; other 3 use `fixed_pct`)

---

## Authentication

`web/app/lib/auth.ts` — every loader/action calls `requireAccess(env.AUTH, request)` first.

Flow: Cloudflare Access injects a `CF_Authorization` JWT → decode email → lookup `dashboard_access` table in `radix-auth` DB → returns access level (none | view | edit | admin). Throws redirect to login if none.

---

## Code Conventions

**Route pattern:** Each route file exports `meta()`, `loader()`, `action()`, and a default component. Loader returns plain data objects; action handles form submissions and redirects back to the same route.

**Queries:** All D1 calls go through functions in `lib/queries.ts`. The `DB` type uses `.prepare().bind().all<T>()` / `.first<T>()` / `.run()` — these return Promises.

**Table layout:** Data tables use `table-layout: fixed` with an exact pixel `width` on the `<table>` style (not `minWidth`) and a `<colgroup>` to enforce column widths. Using `minWidth` breaks fixed layout and causes misalignment.

**Shared scroll container:** All Section tables on the Interco R&D page share one `overflow-x-auto` wrapper so month columns align visually.

**Percentage inputs:** Admin panels that accept % values (0–100) store them as decimals (0–1) in D1. The `save_person_alloc_pct` and `save_enc_alloc_all` action intents handle the ÷100 conversion. The older `save_person_alloc` intent takes raw decimals (legacy existing rows).

**Styling:** Tailwind CSS v4 with a custom design system. Key color tokens: `dash-surface`, `dash-surface-raised`, `dash-nav-bg`, `dash-border`, `dash-accent`, `dash-text`, `dash-text-muted`, `dash-text-secondary`, `dash-warning`, `dash-positive`. Font tokens: `font-heading`, `font-ui`.

**Section component:** `function Section({ title, children, variant })` — `variant="primary"` (default) or `variant="secondary"` (Step 2 bucket boxes on interco-rd).

---

## Excel Exports

Every analysis tab has a client-side **↓ Export to Excel** button in the page header. All generation happens in the browser via `xlsx` (SheetJS) — **xlsx must never run server-side** as it is incompatible with the Cloudflare Workers edge runtime.

**Pattern for every export button:**
```tsx
<button
  onClick={async () => {
    const { generateXxxExcel } = await import("~/lib/excel");
    const data = generateXxxExcel(...args);
    const blob = new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Filename_${year}.xlsx`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }}
>↓ Export to Excel</button>
```

The dynamic `import("~/lib/excel")` ensures xlsx is only loaded in the browser, never during Worker initialization.

**Do NOT add `"compatibility_flags": ["nodejs_compat"]` to `wrangler.jsonc`** — this flag breaks D1 bindings.

### Export contents per tab

| Tab | File | Sheets |
|---|---|---|
| Professional Services | `PS_Labor_{year}.xlsx` | Summary, Journal Entry, Hours by Person, Cost by Person |
| Radix R&D | `RadixRD_{year}.xlsx` | Summary, Journal Entry, Hours by Person, Cost by Person |
| enCompass R&D | `EncRD_{year}.xlsx` | Summary, Journal Entry, Interco Invoice, Hours by Person, Cost by Person |
| Interco R&D | `IntercoRD_{year}.xlsx` | Step 1, Enc Platforms, Data Platforms, Reporting-BI, Maintenance |

All sheet generators live in `web/app/lib/excel.ts`:
- `generatePSExcel(monthly, personRows, year)`
- `generateRadixRDExcel(monthly, personRows, year)`
- `generateEncRDExcel(monthly, personRows, year)`
- `generateIntercoRDExcel(step1, step2, features, year)`

---

## BigTime Data Import

`import_bigtime.py` — run locally to import a BigTime CSV export into D1 via the REST API.

The script:
1. Reads the CSV export from BigTime
2. Applies `project_rules` to map project names → N/C buckets
3. Bulk-inserts into `time_entries` (upsert by unique key)

The `/upload` route shows import status and allows manual monthly overrides.

---

## Current Year

Data is for **2026**. The loader uses `getAvailableYears()` to find the most recent year with data; year selector is not yet built into the UI.

---

## Known Constraints

- **No local Wrangler runtime** on Windows ARM64 — deploy only via GitHub Actions
- **Tax & bene rates** must be seeded in `tax_bene_rates` for each year before calculations are correct
- **Vendor invoices** (Innoscale, Power BI) are pre-populated for all 12 months but gated on `subtotal_labor > 0` — they won't appear until that month's labor is uploaded
- **enc_platform_allocations** must be entered via the admin panel on `/interco-rd` each month before Step 2 calculations for enc_platforms are correct
