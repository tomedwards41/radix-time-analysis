import React, { useState } from "react";
import type { Route } from "./+types/interco-rd";
import { redirect } from "react-router";
import { requireAccess } from "~/lib/auth";
import {
  getRoster, getTaxBeneRates, getVendorInvoices,
  getPersonDetail, getAvailableYears,
  getRateHistory, getAllMonthlyOverridesForYear,
  getRdAllocations, getRdFeatures, getEncPlatformAllocations,
  upsertRdAllocation, upsertEncPlatformAllocation, upsertRdFeature,
  upsertRosterPerson,
  getEncRDStaffMissingAllocations, getUnrosteredStaff,
} from "~/lib/queries";
import {
  resolvePersonCosts, aggregateToCategories,
  computeEncRD, computeStep1, computeStep2, MONTHS,
} from "~/lib/computations";
import { formatCurrencyFull, formatCurrencyAccounting, MONTH_LABELS } from "~/lib/formatters";
import type { RdAllocation, EncPlatformAllocation } from "~/lib/types";

export function meta() {
  return [{ title: "Interco R&D Invoice | Labor Analysis" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  await requireAccess(env.AUTH, request);

  const years = await getAvailableYears(env.DB);
  const year  = years[0] ?? 2026;

  const [personRaw, rates, invoices, roster, rateHistory, overrides, allocations, features, encAllocs, missingEncRDAllocs, unrosteredStaff] =
    await Promise.all([
      getPersonDetail(env.DB, "Enc R&D", year),
      getTaxBeneRates(env.DB, year),
      getVendorInvoices(env.DB, year),
      getRoster(env.DB),
      getRateHistory(env.DB),
      getAllMonthlyOverridesForYear(env.DB, year),
      getRdAllocations(env.DB),
      getRdFeatures(env.DB),
      getEncPlatformAllocations(env.DB, year),
      getEncRDStaffMissingAllocations(env.DB, year),
      getUnrosteredStaff(env.DB),
    ]);

  const personRows  = resolvePersonCosts(personRaw, roster, rateHistory, overrides, "Enc R&D");
  const laborRows   = aggregateToCategories(personRows);
  const encMonthly  = computeEncRD(laborRows, rates, invoices, year);
  const step1       = computeStep1(personRows, allocations, invoices, year);
  const step2       = computeStep2(step1, features, encAllocs, year);

  const ytdMonth = Math.max(...encMonthly.filter((m) => m.cip > 0).map((m) => m.month), 0);

  return { step1, step2, features, allocations, encAllocs, roster, year, ytdMonth, missingEncRDAllocs, unrosteredStaff };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env;
  await requireAccess(env.AUTH, request);

  const form   = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "save_enc_alloc_all") {
    const year = Number(form.get("year"));
    const raw  = JSON.parse(form.get("allocs") as string) as { feature_id: number; month: number; pct: number }[];
    for (const { feature_id, month, pct } of raw) {
      await upsertEncPlatformAllocation(env.DB, feature_id, year, month, pct);
    }
  }

  if (intent === "save_feature") {
    const featureIdRaw = form.get("feature_id") as string;
    await upsertRdFeature(env.DB, {
      id: featureIdRaw ? Number(featureIdRaw) : null,
      bucket: "enc_platforms",
      name: form.get("name") as string,
      status: (form.get("status") as string) || "Active",
    });
  }

  if (intent === "save_person_alloc") {
    const alloc: RdAllocation = {
      name:           form.get("name") as string,
      enc_platforms:  Number(form.get("enc_platforms")),
      data_platforms: Number(form.get("data_platforms")),
      reporting_bi:   Number(form.get("reporting_bi")),
      maintenance:    Number(form.get("maintenance")),
    };
    await upsertRdAllocation(env.DB, alloc);
  }

  // Like save_person_alloc but values submitted as % (0-100) — used by new add/setup forms
  if (intent === "save_person_alloc_pct") {
    await upsertRdAllocation(env.DB, {
      name:           form.get("name") as string,
      enc_platforms:  (parseFloat(form.get("enc_platforms") as string) || 0) / 100,
      data_platforms: (parseFloat(form.get("data_platforms") as string) || 0) / 100,
      reporting_bi:   (parseFloat(form.get("reporting_bi")   as string) || 0) / 100,
      maintenance:    (parseFloat(form.get("maintenance")    as string) || 0) / 100,
    });
  }

  if (intent === "save_full_person_setup") {
    const name          = form.get("name") as string;
    const primaryBucket = (form.get("primary_nc_bucket") as string) || null;
    await upsertRosterPerson(env.DB, {
      name,
      emp_type:          (form.get("emp_type")      as string) || "Employee",
      dept:              (form.get("dept")           as string) || "",
      company:           (form.get("company")        as string) || "",
      sub_category:      (form.get("sub_category")   as string) || null,
      default_alloc:     (form.get("default_alloc")  as string) || "100%",
      primary_nc_bucket: primaryBucket,
      hourly_rate:       form.get("hourly_rate") ? Number(form.get("hourly_rate")) : null,
    });
    if (primaryBucket === "Enc R&D") {
      await upsertRdAllocation(env.DB, {
        name,
        enc_platforms:  (parseFloat(form.get("enc_platforms") as string) || 0) / 100,
        data_platforms: (parseFloat(form.get("data_platforms") as string) || 0) / 100,
        reporting_bi:   (parseFloat(form.get("reporting_bi")   as string) || 0) / 100,
        maintenance:    (parseFloat(form.get("maintenance")    as string) || 0) / 100,
      });
    }
  }

  return redirect("/interco-rd");
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const TH = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <th className={`py-1.5 px-3 text-[10px] font-ui font-semibold text-dash-text-secondary uppercase tracking-wide whitespace-nowrap ${right ? "text-right" : "text-left"}`}>
    {children}
  </th>
);

const TD = ({ children, right, bold, muted }: { children: React.ReactNode; right?: boolean; bold?: boolean; muted?: boolean }) => (
  <td className={`py-1.5 px-3 text-xs font-ui whitespace-nowrap ${right ? "text-right tabular-nums" : ""} ${bold ? "font-semibold text-dash-text" : muted ? "text-dash-text-muted" : "text-dash-text"}`}>
    {children}
  </td>
);

// Fixed colgroup used by every table so month columns align across sections
const TableCols = () => (
  <colgroup>
    <col style={{ width: 270 }} />
    {MONTHS.map((m) => <col key={m} style={{ width: 80 }} />)}
    <col style={{ width: 90 }} />
  </colgroup>
);

// 270 + 80×12 + 90 = 1320 — exact width forces table-layout:fixed to honour colgroup
const TABLE_STYLE: React.CSSProperties = { tableLayout: "fixed", width: 1320 };

function Section({ title, children, variant = "primary" }: { title: string; children: React.ReactNode; variant?: "primary" | "secondary" }) {
  const wrap = variant === "secondary"
    ? "bg-dash-nav-bg rounded-lg border border-dash-accent-muted"
    : "bg-dash-surface rounded-lg border border-dash-border";
  const head = variant === "secondary"
    ? "px-4 py-2.5 border-b border-dash-accent-muted bg-dash-surface rounded-t-lg"
    : "px-4 py-2.5 border-b border-dash-border bg-dash-surface-raised rounded-t-lg";
  return (
    <div className={wrap}>
      <div className={head}>
        <h2 className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-widest">{title}</h2>
      </div>
      {children}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function IntercoRDRoute({ loaderData }: Route.ComponentProps) {
  const { step1, step2, features, allocations, encAllocs, roster, year, ytdMonth, missingEncRDAllocs, unrosteredStaff } = loaderData;

  // ytdMonths = months that have actual data (for YTD sums / KPI cards)
  const ytdMonths = step1.filter((m) => m.total > 0).map((m) => m.month);

  // Step 2 grouped by bucket
  const bucketLabels: Record<string, string> = {
    enc_platforms: "enCompass Platforms",
    data_platforms: "Data Platforms",
    reporting_bi: "Reporting / BI",
    maintenance: "Maintenance",
  };

  const buckets = ["enc_platforms", "data_platforms", "reporting_bi", "maintenance"] as const;

  const step2Amount = (featureId: number, month: number) =>
    step2.find((r) => r.feature_id === featureId && r.month === month)?.amount ?? 0;

  const step2YTD = (featureId: number) =>
    ytdMonths.reduce((s, m) => s + step2Amount(featureId, m), 0);

  // ── Admin panel state ──────────────────────────────────────────────────────

  const [showEncAdmin, setShowEncAdmin]         = useState(false);
  const [showPersonAdmin, setShowPersonAdmin]   = useState(false);
  const [showFeatureAdmin, setShowFeatureAdmin] = useState(false);

  const allEncFeatures = features.filter((f) => f.bucket === "enc_platforms");
  const [featureEdits, setFeatureEdits] = useState<Record<number, { name: string; status: string }>>(() =>
    Object.fromEntries(allEncFeatures.map((f) => [f.id, { name: f.name, status: f.status }]))
  );

  // enc_platform admin: local edits keyed by "feature_id:month", stored as % (0-100)
  const [encEdits, setEncEdits] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const a of encAllocs) {
      init[`${a.feature_id}:${a.month}`] = (a.allocation_pct * 100).toFixed(1);
    }
    return init;
  });

  // person alloc admin: local edits keyed by "name:field"
  const [personEdits, setPersonEdits] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const a of allocations) {
      init[`${a.name}:enc_platforms`]  = String(a.enc_platforms);
      init[`${a.name}:data_platforms`] = String(a.data_platforms);
      init[`${a.name}:reporting_bi`]   = String(a.reporting_bi);
      init[`${a.name}:maintenance`]    = String(a.maintenance);
    }
    return init;
  });

  const encFeatures = features.filter((f) => f.bucket === "enc_platforms" && f.status === "Active");

  // ── Setup-required state ───────────────────────────────────────────────────

  const rosterNames      = new Set(roster.map((r) => r.name));
  const missingInRoster  = missingEncRDAllocs.filter((n) =>  rosterNames.has(n));
  const missingNotInRoster = missingEncRDAllocs.filter((n) => !rosterNames.has(n));
  const otherUnrostered  = unrosteredStaff.filter((n) => !missingEncRDAllocs.includes(n));
  const totalSetupNeeded = missingEncRDAllocs.length + otherUnrostered.length;

  const [showSetupPanel, setShowSetupPanel] = useState(true);

  const allocFields = ["enc_platforms", "data_platforms", "reporting_bi", "maintenance"] as const;

  const [missingAllocEdits, setMissingAllocEdits] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(missingEncRDAllocs.map((name) => [name, { enc_platforms: "0.0", data_platforms: "0.0", reporting_bi: "0.0", maintenance: "0.0" }]))
  );

  const [fullSetupEdits, setFullSetupEdits] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(
      missingNotInRoster.map((name) => [name, {
        emp_type: "Employee", dept: "", company: "",
        sub_category: "", default_alloc: "100%", primary_nc_bucket: "Enc R&D", hourly_rate: "",
      }])
    )
  );

  const [addPersonName, setAddPersonName]     = useState("");
  const [addPersonAllocs, setAddPersonAllocs] = useState<Record<string, string>>({
    enc_platforms: "0.0", data_platforms: "0.0", reporting_bi: "0.0", maintenance: "0.0",
  });

  // Months to show in enc admin — months that have labor data
  const adminMonths = ytdMonths.length > 0 ? ytdMonths : [1, 2, 3];

  // Totals per month for enc admin (0-100 scale)
  const encMonthTotal = (month: number) => {
    let total = 0;
    for (const f of encFeatures) {
      total += parseFloat(encEdits[`${f.id}:${month}`] ?? "0") || 0;
    }
    return total;
  };
  const encMonthValid = (month: number) => Math.abs(encMonthTotal(month) - 100) < 0.1;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-heading font-semibold text-dash-text">Interco R&D Invoice</h1>
          <p className="text-xs text-dash-text-muted font-ui">
            enCompass R&D allocation to activity buckets and features — {year} · YTD through {MONTH_LABELS[(ytdMonth || 1) - 1]}
          </p>
        </div>
        <button
          onClick={async () => {
            const { generateIntercoRDExcel } = await import("~/lib/excel");
            const data = generateIntercoRDExcel(step1, step2, features, year);
            const blob = new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `IntercoRD_${year}.xlsx`;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a); URL.revokeObjectURL(url);
          }}
          className="flex-shrink-0 px-3 py-1.5 text-xs font-ui font-medium rounded border transition-colors bg-dash-accent/10 text-dash-accent border-dash-accent/30 hover:bg-dash-accent/20"
        >
          ↓ Export to Excel
        </button>
      </div>

      {/* Step 1 KPI cards */}
      <div className="flex gap-2.5 flex-wrap">
        {buckets.map((b) => {
          const ytd = ytdMonths.reduce((s, m) => s + (step1.find((r) => r.month === m)?.[b] ?? 0), 0);
          return (
            <div key={b} className="bg-dash-surface rounded-lg border border-dash-border p-3.5 flex flex-col gap-1 min-w-[140px] flex-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-white/20 cursor-default">
              <p className="text-[10px] font-ui font-medium text-dash-text-secondary uppercase tracking-[0.12em]">{bucketLabels[b]}</p>
              <p className="text-[20px] font-heading font-semibold text-dash-accent leading-tight">{formatCurrencyFull(ytd)}</p>
              <p className="text-[10px] text-dash-text-muted">YTD incl. 15% markup</p>
            </div>
          );
        })}
        <div className="bg-dash-surface rounded-lg border border-dash-border p-3.5 flex flex-col gap-1 min-w-[140px] flex-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-white/20 cursor-default">
          <p className="text-[10px] font-ui font-medium text-dash-text-secondary uppercase tracking-[0.12em]">Total Invoice</p>
          <p className="text-[20px] font-heading font-semibold text-dash-accent leading-tight">
            {formatCurrencyFull(ytdMonths.reduce((s, m) => s + (step1.find((r) => r.month === m)?.total ?? 0), 0))}
          </p>
          <p className="text-[10px] text-dash-text-muted">YTD incl. 15% markup</p>
        </div>
      </div>

      {/* All data tables share one scroll container so month columns align */}
      <div className="overflow-x-auto space-y-4" style={{ minWidth: 0 }}>

        {/* Step 1 — categories as rows, all 12 months as columns */}
        <Section title="enCompass R&D Interco Allocation (incl. 15% markup)">
          <table style={TABLE_STYLE}>
            <TableCols />
            <thead>
              <tr className="bg-dash-surface-raised">
                <TH>Category</TH>
                {MONTHS.map((m) => (
                  <TH key={m} right>{MONTH_LABELS[m - 1]}-{String(year).slice(-2)}</TH>
                ))}
                <TH right>YTD</TH>
              </tr>
            </thead>
            <tbody className="divide-y divide-dash-border-divider">
              {buckets.map((b) => {
                const rowYTD = ytdMonths.reduce((s, m) => s + (step1.find((r) => r.month === m)?.[b] ?? 0), 0);
                return (
                  <tr key={b} className="hover:bg-dash-surface-raised/50 transition-colors">
                    <TD>{bucketLabels[b]}</TD>
                    {MONTHS.map((m) => {
                      const val = step1.find((r) => r.month === m)?.[b] ?? 0;
                      return (
                        <TD key={m} right muted={val === 0}>{val === 0 ? "—" : formatCurrencyAccounting(val)}</TD>
                      );
                    })}
                    <TD right bold>{formatCurrencyAccounting(rowYTD)}</TD>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-dash-border">
                <TD bold>Total</TD>
                {MONTHS.map((m) => {
                  const val = step1.find((r) => r.month === m)?.total ?? 0;
                  return <TD key={m} right bold muted={val === 0}>{val === 0 ? "—" : formatCurrencyAccounting(val)}</TD>;
                })}
                <TD right bold>
                  {formatCurrencyAccounting(ytdMonths.reduce((s, m) => s + (step1.find((r) => r.month === m)?.total ?? 0), 0))}
                </TD>
              </tr>
            </tfoot>
          </table>
        </Section>

        {/* Step 2 — one section per bucket */}
        {buckets.map((bucket) => {
          const bucketFeatures = bucket === "enc_platforms"
            ? features.filter((f) => f.bucket === "enc_platforms" && step2.some((r) => r.bucket === "enc_platforms" && r.feature_id === f.id))
            : features.filter((f) => f.bucket === bucket && f.fixed_pct != null && f.fixed_pct > 0);

          if (bucketFeatures.length === 0) return null;

          const bucketVal  = (month: number) => step1.find((r) => r.month === month)?.[bucket] ?? 0;
          const bucketYTD  = ytdMonths.reduce((s, m) => s + bucketVal(m), 0);

          return (
            <Section key={bucket} title={bucketLabels[bucket]} variant="secondary">
              <table style={TABLE_STYLE}>
                <TableCols />
                <thead>
                  <tr className="bg-dash-surface-raised">
                    <TH>Feature</TH>
                    {MONTHS.map((m) => (
                      <TH key={m} right>{MONTH_LABELS[m - 1]}-{String(year).slice(-2)}</TH>
                    ))}
                    <TH right>YTD</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dash-border-divider">
                  {bucketFeatures.map((f) => (
                    <tr key={f.id} className="hover:bg-dash-surface-raised/50 transition-colors">
                      <TD>{f.name}</TD>
                      {MONTHS.map((m) => {
                        const val = step2Amount(f.id, m);
                        return (
                          <TD key={m} right muted={val === 0}>{val === 0 ? "—" : formatCurrencyAccounting(val)}</TD>
                        );
                      })}
                      <TD right bold>{step2YTD(f.id) === 0 ? "—" : formatCurrencyAccounting(step2YTD(f.id))}</TD>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-dash-border">
                    <TD bold>Total {bucketLabels[bucket]}</TD>
                    {MONTHS.map((m) => {
                      const val = bucketVal(m);
                      return <TD key={m} right bold muted={val === 0}>{val === 0 ? "—" : formatCurrencyAccounting(val)}</TD>;
                    })}
                    <TD right bold>{bucketYTD === 0 ? "—" : formatCurrencyAccounting(bucketYTD)}</TD>
                  </tr>
                </tfoot>
              </table>
            </Section>
          );
        })}

      </div>{/* end shared scroll container */}

      {/* Setup Required — flagged people needing configuration */}
      {totalSetupNeeded > 0 && (
        <div className="bg-dash-surface rounded-lg border border-dash-warning/40 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowSetupPanel((v) => !v)}
            className="w-full px-4 py-2.5 border-b border-dash-warning/40 bg-dash-warning/5 flex items-center justify-between hover:bg-dash-warning/10 transition-colors"
          >
            <h2 className="text-[11px] font-ui font-semibold text-dash-warning uppercase tracking-widest">
              ⚠ Setup Required — {totalSetupNeeded} {totalSetupNeeded === 1 ? "person needs" : "people need"} configuration
            </h2>
            <span className="text-[10px] text-dash-text-muted">{showSetupPanel ? "▲ Collapse" : "▼ Expand"}</span>
          </button>
          {showSetupPanel && (
            <div className="p-4 space-y-6">

              {/* Not in roster at all — full setup */}
              {missingNotInRoster.length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-wide">
                    Enc R&D Staff — Not in Roster (complete setup required)
                  </p>
                  {missingNotInRoster.map((name) => {
                    const edits    = fullSetupEdits[name] ?? {};
                    const bucket   = edits.primary_nc_bucket ?? "Enc R&D";
                    const setEdit  = (k: string, v: string) => setFullSetupEdits((p) => ({ ...p, [name]: { ...p[name], [k]: v } }));
                    const setAlloc = (k: string, v: string) => setMissingAllocEdits((p) => ({ ...p, [name]: { ...p[name], [k]: v } }));
                    const allocTotal = allocFields.reduce((s, k) => s + (parseFloat(missingAllocEdits[name]?.[k] ?? "0") || 0), 0);
                    const allocValid = Math.abs(allocTotal - 100) < 0.1;
                    return (
                      <div key={name} className="border border-dash-warning/20 rounded-lg p-3 space-y-3">
                        <p className="text-xs font-ui font-semibold text-dash-text">{name}</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                          {([
                            ["Type",         "emp_type",          "select",  ["Employee","Contract"]],
                            ["Company",      "company",           "text",    null],
                            ["Dept",         "dept",              "text",    null],
                            ["Sub-Category", "sub_category",      "text",    null],
                            ["Default Alloc","default_alloc",     "text",    null],
                            ["Hourly Rate",  "hourly_rate",       "number",  null],
                          ] as [string, string, string, string[] | null][]).map(([label, field, type, opts]) => (
                            <div key={field} className="flex flex-col gap-0.5">
                              <label className="text-[10px] font-ui text-dash-text-muted uppercase">{label}</label>
                              {type === "select" ? (
                                <select
                                  value={edits[field] ?? "Employee"}
                                  onChange={(e) => setEdit(field, e.target.value)}
                                  className="bg-dash-surface-raised border border-dash-border rounded px-2 py-0.5 text-xs font-ui text-dash-text focus:outline-none focus:border-dash-accent"
                                >
                                  {opts!.map((o) => <option key={o} value={o}>{o}</option>)}
                                </select>
                              ) : (
                                <input
                                  type={type}
                                  step={type === "number" ? "0.01" : undefined}
                                  value={edits[field] ?? ""}
                                  onChange={(e) => setEdit(field, e.target.value)}
                                  className="bg-dash-surface-raised border border-dash-border rounded px-2 py-0.5 text-xs font-ui text-dash-text focus:outline-none focus:border-dash-accent"
                                />
                              )}
                            </div>
                          ))}
                          <div className="flex flex-col gap-0.5">
                            <label className="text-[10px] font-ui text-dash-text-muted uppercase">Primary NC Bucket</label>
                            <select
                              value={bucket}
                              onChange={(e) => setEdit("primary_nc_bucket", e.target.value)}
                              className="bg-dash-surface-raised border border-dash-border rounded px-2 py-0.5 text-xs font-ui text-dash-text focus:outline-none focus:border-dash-accent"
                            >
                              <option value="Enc R&D">Enc R&D</option>
                              <option value="PS">PS</option>
                              <option value="Radix R&D">Radix R&D</option>
                              <option value="Internal">Internal</option>
                              <option value="">— None —</option>
                            </select>
                          </div>
                        </div>
                        {bucket === "Enc R&D" && (
                          <div className="border-t border-dash-border/50 pt-2 space-y-1">
                            <p className="text-[10px] font-ui text-dash-text-muted uppercase tracking-wide">Bucket Allocations</p>
                            <div className="flex items-center gap-4 flex-wrap">
                              {allocFields.map((field) => (
                                <div key={field} className="flex items-center gap-1">
                                  <label className="text-[10px] text-dash-text-muted">{bucketLabels[field]}</label>
                                  <input
                                    type="number" step="0.1" min="0" max="100"
                                    value={missingAllocEdits[name]?.[field] ?? "0.0"}
                                    onChange={(e) => setAlloc(field, e.target.value)}
                                    onBlur={(e) => setAlloc(field, (parseFloat(e.target.value) || 0).toFixed(1))}
                                    className="w-14 bg-dash-surface-raised border border-dash-border rounded px-1.5 py-0.5 text-xs font-ui text-dash-text text-right focus:outline-none focus:border-dash-accent"
                                  />
                                  <span className="text-[10px] text-dash-text-muted">%</span>
                                </div>
                              ))}
                              <span className={`text-xs font-ui font-semibold ${allocValid ? "text-dash-positive" : "text-dash-warning"}`}>
                                Total: {allocTotal.toFixed(1)}%
                              </span>
                            </div>
                          </div>
                        )}
                        <form method="post">
                          <input type="hidden" name="intent"            value="save_full_person_setup" />
                          <input type="hidden" name="name"              value={name} />
                          <input type="hidden" name="emp_type"          value={edits.emp_type          ?? "Employee"} />
                          <input type="hidden" name="dept"              value={edits.dept              ?? ""} />
                          <input type="hidden" name="company"           value={edits.company           ?? ""} />
                          <input type="hidden" name="sub_category"      value={edits.sub_category      ?? ""} />
                          <input type="hidden" name="default_alloc"     value={edits.default_alloc     ?? "100%"} />
                          <input type="hidden" name="primary_nc_bucket" value={bucket} />
                          <input type="hidden" name="hourly_rate"       value={edits.hourly_rate       ?? ""} />
                          {bucket === "Enc R&D" && allocFields.map((f) => (
                            <input key={f} type="hidden" name={f} value={missingAllocEdits[name]?.[f] ?? "0"} />
                          ))}
                          <button type="submit" className="px-3 py-1 text-xs font-ui font-medium rounded border transition-colors bg-dash-accent/10 text-dash-accent border-dash-accent/30 hover:bg-dash-accent/20">
                            Save &amp; Add to Roster
                          </button>
                        </form>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* In roster, but missing allocations */}
              {missingInRoster.length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-wide">
                    Enc R&D Staff — Missing Bucket Allocations
                  </p>
                  {missingInRoster.map((name) => {
                    const setAlloc   = (k: string, v: string) => setMissingAllocEdits((p) => ({ ...p, [name]: { ...p[name], [k]: v } }));
                    const allocTotal = allocFields.reduce((s, k) => s + (parseFloat(missingAllocEdits[name]?.[k] ?? "0") || 0), 0);
                    const allocValid = Math.abs(allocTotal - 100) < 0.1;
                    return (
                      <div key={name} className="border border-dash-warning/20 rounded-lg p-3 space-y-2">
                        <p className="text-xs font-ui font-semibold text-dash-text">{name}</p>
                        <div className="flex items-center gap-4 flex-wrap">
                          {allocFields.map((field) => (
                            <div key={field} className="flex items-center gap-1">
                              <label className="text-[10px] text-dash-text-muted">{bucketLabels[field]}</label>
                              <input
                                type="number" step="0.1" min="0" max="100"
                                value={missingAllocEdits[name]?.[field] ?? "0.0"}
                                onChange={(e) => setAlloc(field, e.target.value)}
                                onBlur={(e) => setAlloc(field, (parseFloat(e.target.value) || 0).toFixed(1))}
                                className="w-14 bg-dash-surface-raised border border-dash-border rounded px-1.5 py-0.5 text-xs font-ui text-dash-text text-right focus:outline-none focus:border-dash-accent"
                              />
                              <span className="text-[10px] text-dash-text-muted">%</span>
                            </div>
                          ))}
                          <span className={`text-xs font-ui font-semibold ${allocValid ? "text-dash-positive" : "text-dash-warning"}`}>
                            Total: {allocTotal.toFixed(1)}%
                          </span>
                        </div>
                        <form method="post">
                          <input type="hidden" name="intent"        value="save_person_alloc_pct" />
                          <input type="hidden" name="name"          value={name} />
                          {allocFields.map((f) => (
                            <input key={f} type="hidden" name={f} value={missingAllocEdits[name]?.[f] ?? "0"} />
                          ))}
                          <button type="submit" disabled={!allocValid} className="px-3 py-1 text-xs font-ui font-medium rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-dash-accent/10 text-dash-accent border-dash-accent/30 hover:bg-dash-accent/20">
                            Save Allocations
                          </button>
                        </form>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Other unrostered (not Enc R&D) */}
              {otherUnrostered.length > 0 && (
                <div>
                  <p className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-wide mb-2">
                    Other Staff — Not in Roster
                  </p>
                  <p className="text-xs text-dash-text-muted font-ui mb-2">
                    These people appear in time entries but are not in the roster. Add them on the{" "}
                    <a href="/roster" className="text-dash-accent hover:underline">Roster page</a>.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {otherUnrostered.map((name) => (
                      <span key={name} className="px-2 py-0.5 text-xs font-ui text-dash-warning bg-dash-warning/10 border border-dash-warning/20 rounded">
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
      )}

      {/* Admin: enCompass Platform Features */}
      <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
        <button
          type="button"
          onClick={() => setShowFeatureAdmin((v) => !v)}
          className="w-full px-4 py-2.5 border-b border-dash-border bg-dash-surface-raised flex items-center justify-between hover:bg-dash-surface transition-colors"
        >
          <h2 className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-widest">
            Admin — enCompass Platform Features
          </h2>
          <span className="text-[10px] text-dash-text-muted">{showFeatureAdmin ? "▲ Collapse" : "▼ Expand"}</span>
        </button>
        {showFeatureAdmin && (
          <div className="p-4 space-y-4">
            <p className="text-xs text-dash-text-muted font-ui">
              Add or rename enCompass Platform features/versions. Active features appear in the allocation tables and monthly % editor.
            </p>
            <table className="w-auto min-w-[520px]">
              <thead>
                <tr className="bg-dash-surface-raised">
                  <TH>Feature / Version Name</TH>
                  <TH>Status</TH>
                  <TH></TH>
                </tr>
              </thead>
              <tbody className="divide-y divide-dash-border-divider">
                {allEncFeatures.map((f) => (
                  <tr key={f.id} className="hover:bg-dash-surface-raised/50">
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        value={featureEdits[f.id]?.name ?? f.name}
                        onChange={(e) => setFeatureEdits((prev) => ({ ...prev, [f.id]: { ...prev[f.id], name: e.target.value } }))}
                        className="w-72 bg-dash-surface-raised border border-dash-border rounded px-2 py-0.5 text-xs font-ui text-dash-text focus:outline-none focus:border-dash-accent"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <select
                        value={featureEdits[f.id]?.status ?? f.status}
                        onChange={(e) => setFeatureEdits((prev) => ({ ...prev, [f.id]: { ...prev[f.id], status: e.target.value } }))}
                        className="bg-dash-surface-raised border border-dash-border rounded px-2 py-0.5 text-xs font-ui text-dash-text focus:outline-none focus:border-dash-accent"
                      >
                        <option value="Active">Active</option>
                        <option value="Inactive">Inactive</option>
                      </select>
                    </td>
                    <td className="py-1.5 px-2">
                      <form method="post">
                        <input type="hidden" name="intent"     value="save_feature" />
                        <input type="hidden" name="feature_id" value={f.id} />
                        <input type="hidden" name="name"       value={featureEdits[f.id]?.name ?? f.name} />
                        <input type="hidden" name="status"     value={featureEdits[f.id]?.status ?? f.status} />
                        <button
                          type="submit"
                          className="px-2.5 py-0.5 text-[10px] font-ui font-medium rounded border transition-colors bg-dash-accent/10 text-dash-accent border-dash-accent/30 hover:bg-dash-accent/20"
                        >
                          Save
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-dash-border pt-4">
              <p className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-wide mb-2">Add New Feature</p>
              <form method="post" className="flex items-center gap-3">
                <input type="hidden" name="intent"     value="save_feature" />
                <input type="hidden" name="feature_id" value="" />
                <input type="hidden" name="status"     value="Active" />
                <input
                  type="text"
                  name="name"
                  placeholder="Feature / version name…"
                  className="w-72 bg-dash-surface-raised border border-dash-border rounded px-2 py-1 text-xs font-ui text-dash-text focus:outline-none focus:border-dash-accent placeholder:text-dash-text-muted/50"
                />
                <button
                  type="submit"
                  className="px-3 py-1 text-xs font-ui font-medium rounded border transition-colors bg-dash-accent/10 text-dash-accent border-dash-accent/30 hover:bg-dash-accent/20"
                >
                  Add Feature
                </button>
              </form>
            </div>
          </div>
        )}
      </div>

      {/* Admin: enCompass Platform Monthly Allocations */}
      <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
        <button
          type="button"
          onClick={() => setShowEncAdmin((v) => !v)}
          className="w-full px-4 py-2.5 border-b border-dash-border bg-dash-surface-raised flex items-center justify-between hover:bg-dash-surface transition-colors"
        >
          <h2 className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-widest">
            Admin — enCompass Platform Monthly Allocations
          </h2>
          <span className="text-[10px] text-dash-text-muted">{showEncAdmin ? "▲ Collapse" : "▼ Expand"}</span>
        </button>
        {showEncAdmin && (
          <div className="p-4">
            <p className="text-xs text-dash-text-muted font-ui mb-4">
              Enter the % of each month's enCompass Platforms bucket allocated to each active feature. Each column must total 100%.
            </p>
            <form method="post">
              <input type="hidden" name="intent" value="save_enc_alloc_all" />
              <input type="hidden" name="year"   value={year} />
              <input
                type="hidden"
                name="allocs"
                value={JSON.stringify(
                  encFeatures.flatMap((f) =>
                    MONTHS.map((m) => ({
                      feature_id: f.id,
                      month: m,
                      pct: (parseFloat(encEdits[`${f.id}:${m}`] ?? "0") || 0) / 100,
                    }))
                  )
                )}
              />
              <div className="overflow-x-auto">
                <table className="w-auto border-collapse">
                  <thead>
                    <tr className="bg-dash-surface-raised">
                      <th className="py-1.5 px-3 text-left text-[10px] font-ui font-semibold text-dash-text-secondary uppercase tracking-wide whitespace-nowrap min-w-[180px]">Feature</th>
                      {MONTHS.map((m) => (
                        <th key={m} className="py-1.5 px-1.5 text-center text-[10px] font-ui font-semibold text-dash-text-secondary uppercase tracking-wide whitespace-nowrap w-14">
                          {MONTH_LABELS[m - 1]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dash-border-divider">
                    {encFeatures.map((f) => (
                      <tr key={f.id} className="hover:bg-dash-surface-raised/50">
                        <td className="py-1.5 px-3 text-xs font-ui text-dash-text whitespace-nowrap">{f.name}</td>
                        {MONTHS.map((m) => (
                          <td key={m} className="py-1 px-1">
                            <div className="flex items-center gap-0.5">
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                max="100"
                                value={encEdits[`${f.id}:${m}`] ?? ""}
                                placeholder="0.0"
                                onChange={(e) => setEncEdits((prev) => ({ ...prev, [`${f.id}:${m}`]: e.target.value }))}
                                onBlur={(e) => {
                                  const n = parseFloat(e.target.value) || 0;
                                  setEncEdits((prev) => ({ ...prev, [`${f.id}:${m}`]: n.toFixed(1) }));
                                }}
                                className="w-14 bg-dash-surface-raised border border-dash-border rounded px-1.5 py-0.5 text-xs font-ui text-dash-text text-right focus:outline-none focus:border-dash-accent"
                              />
                              <span className="text-[10px] text-dash-text-muted">%</span>
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-dash-border">
                      <td className="py-1.5 px-3 text-xs font-ui font-semibold text-dash-text">Total</td>
                      {MONTHS.map((m) => {
                        const total = encMonthTotal(m);
                        const valid = encMonthValid(m);
                        const color = total === 0 ? "text-dash-text-muted" : valid ? "text-dash-positive" : "text-dash-warning";
                        return (
                          <td key={m} className={`py-1.5 px-1 text-center text-xs font-ui font-semibold tabular-nums ${color}`}>
                            {total === 0 ? "—" : `${total.toFixed(1)}%`}
                          </td>
                        );
                      })}
                    </tr>
                  </tfoot>
                </table>
              </div>
              <button
                type="submit"
                className="mt-4 px-4 py-1.5 text-xs font-ui font-medium rounded border transition-colors bg-dash-accent/10 text-dash-accent border-dash-accent/30 hover:bg-dash-accent/20"
              >
                Save All
              </button>
            </form>
          </div>
        )}
      </div>

      {/* Admin: Person Allocations */}
      <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
        <button
          type="button"
          onClick={() => setShowPersonAdmin((v) => !v)}
          className="w-full px-4 py-2.5 border-b border-dash-border bg-dash-surface-raised flex items-center justify-between hover:bg-dash-surface transition-colors"
        >
          <h2 className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-widest">
            Admin — Person &amp; Vendor Allocations
          </h2>
          <span className="text-[10px] text-dash-text-muted">{showPersonAdmin ? "▲ Collapse" : "▼ Expand"}</span>
        </button>
        {showPersonAdmin && (
          <div>
            <div className="overflow-x-auto">
            <table className="w-auto min-w-full">
              <thead>
                <tr className="bg-dash-surface-raised">
                  <TH>Name</TH>
                  <TH right>enCompass Plat %</TH>
                  <TH right>Data Plat %</TH>
                  <TH right>Reporting/BI %</TH>
                  <TH right>Maintenance %</TH>
                  <TH right>Total</TH>
                  <TH></TH>
                </tr>
              </thead>
              <tbody className="divide-y divide-dash-border-divider">
                {allocations.map((alloc) => {
                  const fields = ["enc_platforms", "data_platforms", "reporting_bi", "maintenance"] as const;
                  const rowTotal = fields.reduce((s, f) => s + (parseFloat(personEdits[`${alloc.name}:${f}`] ?? "0") || 0), 0);
                  const isValid  = Math.abs(rowTotal - 1.0) < 0.001;
                  return (
                    <tr key={alloc.name} className="hover:bg-dash-surface-raised/50">
                      <TD>{alloc.name}</TD>
                      {fields.map((field) => (
                        <td key={field} className="py-1.5 px-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max="1"
                            value={personEdits[`${alloc.name}:${field}`] ?? "0"}
                            onChange={(e) => setPersonEdits((prev) => ({ ...prev, [`${alloc.name}:${field}`]: e.target.value }))}
                            className="w-20 bg-dash-surface-raised border border-dash-border rounded px-2 py-0.5 text-xs font-ui text-dash-text text-right focus:outline-none focus:border-dash-accent"
                          />
                        </td>
                      ))}
                      <td className={`py-1.5 px-3 text-xs font-ui text-right tabular-nums font-semibold ${isValid ? "text-dash-positive" : "text-dash-warning"}`}>
                        {(rowTotal * 100).toFixed(0)}%
                      </td>
                      <td className="py-1.5 px-2">
                        <form method="post">
                          <input type="hidden" name="intent"         value="save_person_alloc" />
                          <input type="hidden" name="name"           value={alloc.name} />
                          <input type="hidden" name="enc_platforms"  value={personEdits[`${alloc.name}:enc_platforms`]  ?? "0"} />
                          <input type="hidden" name="data_platforms" value={personEdits[`${alloc.name}:data_platforms`] ?? "0"} />
                          <input type="hidden" name="reporting_bi"   value={personEdits[`${alloc.name}:reporting_bi`]   ?? "0"} />
                          <input type="hidden" name="maintenance"    value={personEdits[`${alloc.name}:maintenance`]    ?? "0"} />
                          <button
                            type="submit"
                            disabled={!isValid}
                            className="px-2.5 py-0.5 text-[10px] font-ui font-medium rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-dash-accent/10 text-dash-accent border-dash-accent/30 hover:bg-dash-accent/20"
                          >
                            Save
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            {/* Add Person */}
            <div className="border-t border-dash-border p-4 space-y-3">
              <p className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-wide">Add Person</p>
              <div className="flex items-center gap-3">
                <label className="text-xs font-ui text-dash-text-muted w-12">Name</label>
                <input
                  type="text"
                  list="add-person-candidates"
                  value={addPersonName}
                  onChange={(e) => setAddPersonName(e.target.value)}
                  placeholder="Enter name…"
                  className="w-64 bg-dash-surface-raised border border-dash-border rounded px-2 py-0.5 text-xs font-ui text-dash-text focus:outline-none focus:border-dash-accent"
                />
                <datalist id="add-person-candidates">
                  {roster
                    .filter((r) => r.primary_nc_bucket === "Enc R&D" && !allocations.some((a) => a.name === r.name))
                    .map((r) => <option key={r.name} value={r.name} />)}
                </datalist>
              </div>
              <div className="flex items-center gap-4 flex-wrap">
                {allocFields.map((field) => (
                  <div key={field} className="flex items-center gap-1">
                    <label className="text-[10px] text-dash-text-muted">{bucketLabels[field]}</label>
                    <input
                      type="number" step="0.1" min="0" max="100"
                      value={addPersonAllocs[field] ?? "0.0"}
                      onChange={(e) => setAddPersonAllocs((p) => ({ ...p, [field]: e.target.value }))}
                      onBlur={(e) => setAddPersonAllocs((p) => ({ ...p, [field]: (parseFloat(e.target.value) || 0).toFixed(1) }))}
                      className="w-14 bg-dash-surface-raised border border-dash-border rounded px-1.5 py-0.5 text-xs font-ui text-dash-text text-right focus:outline-none focus:border-dash-accent"
                    />
                    <span className="text-[10px] text-dash-text-muted">%</span>
                  </div>
                ))}
                {(() => {
                  const total = allocFields.reduce((s, k) => s + (parseFloat(addPersonAllocs[k] ?? "0") || 0), 0);
                  return <span className={`text-xs font-ui font-semibold ${Math.abs(total - 100) < 0.1 ? "text-dash-positive" : "text-dash-warning"}`}>Total: {total.toFixed(1)}%</span>;
                })()}
              </div>
              <form method="post">
                <input type="hidden" name="intent" value="save_person_alloc_pct" />
                <input type="hidden" name="name"   value={addPersonName} />
                {allocFields.map((f) => (
                  <input key={f} type="hidden" name={f} value={addPersonAllocs[f] ?? "0"} />
                ))}
                <button
                  type="submit"
                  disabled={!addPersonName.trim()}
                  className="px-3 py-1 text-xs font-ui font-medium rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-dash-accent/10 text-dash-accent border-dash-accent/30 hover:bg-dash-accent/20"
                >
                  Add Person
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
