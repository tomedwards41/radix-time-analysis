import { Form } from "react-router";
import type { Route } from "./+types/upload";
import { requireAccess } from "~/lib/auth";
import {
  getImportSummary, getAvailableYears,
  getEncRDOverridePeople, getMonthlyOverrides, saveMonthlyOverrides,
} from "~/lib/queries";
import { formatCurrencyFull, formatHours, MONTH_LABELS } from "~/lib/formatters";
import Badge from "~/components/ui/Badge";

export function meta() {
  return [{ title: "Data Import | Labor Analysis" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  await requireAccess(env.AUTH, request);

  const url = new URL(request.url);
  const overrideYear  = parseInt(url.searchParams.get("oy") || "") || new Date().getFullYear();
  const overrideMonth = parseInt(url.searchParams.get("om") || "") || new Date().getMonth() + 1;

  const [summary, years, encRDPeople, existingOverrides] = await Promise.all([
    getImportSummary(env.DB),
    getAvailableYears(env.DB),
    getEncRDOverridePeople(env.DB),
    getMonthlyOverrides(env.DB, overrideYear, overrideMonth),
  ]);

  return { summary, years, encRDPeople, existingOverrides, overrideYear, overrideMonth };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env;
  await requireAccess(env.AUTH, request);

  const formData = await request.formData();
  const year  = parseInt(formData.get("year")  as string);
  const month = parseInt(formData.get("month") as string);

  // People list is a JSON array of names passed as a hidden field
  const peopleJson = formData.get("allPeople") as string;
  const people: string[] = peopleJson ? JSON.parse(peopleJson) : [];

  const overrides = people.map((name) => ({
    staff_member:     name,
    nc_bucket:        "Enc R&D",
    use_monthly_rate: formData.get(`override||${name}||Enc R&D`) === "1" ? 1 : 0,
  }));

  await saveMonthlyOverrides(env.DB, year, month, overrides);
  return null;
}

const NC_BADGE: Record<string, "green" | "blue" | "purple" | "gray"> = {
  "Chargeable": "green",
  "R&D":        "blue",
  "Enc R&D":    "purple",
  "OH":         "gray",
};

export default function UploadRoute({ loaderData }: Route.ComponentProps) {
  const { summary, years, encRDPeople, existingOverrides, overrideYear, overrideMonth } = loaderData;

  const totalRows   = summary.reduce((s, r) => s + r.row_count, 0);
  const totalHours  = summary.reduce((s, r) => s + r.total_hours, 0);
  const totalCost   = summary.reduce((s, r) => s + (r.total_cost ?? 0), 0);

  // Group by year/month for the summary grid
  const byYearMonth: Record<string, typeof summary> = {};
  for (const row of summary) {
    const key = `${row.year}-${String(row.month).padStart(2, "0")}`;
    if (!byYearMonth[key]) byYearMonth[key] = [];
    byYearMonth[key].push(row);
  }
  const periodKeys = Object.keys(byYearMonth).sort().reverse();

  // Determine checked state for each person: override record if present, else default = checked (100%)
  function isChecked(name: string) {
    const ov = existingOverrides.find((o) => o.staff_member === name && o.nc_bucket === "Enc R&D");
    return ov ? ov.use_monthly_rate === 1 : true; // default = 100% checked
  }

  const allPeopleJson = JSON.stringify(encRDPeople.map((p) => p.staff_member));

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="text-lg font-heading font-semibold text-dash-text">Data Import</h1>
        <p className="text-xs text-dash-text-muted font-ui">
          Import BigTime CSV exports using the Python script below. Data is stored in Cloudflare D1.
        </p>
      </div>

      {/* Quick stats */}
      <div className="flex gap-2.5 flex-wrap">
        <StatCard label="Total Rows"    value={totalRows.toLocaleString()} />
        <StatCard label="Total Hours"   value={formatHours(totalHours)} />
        <StatCard label="Total Cost"    value={formatCurrencyFull(totalCost)} />
        <StatCard label="Years on File" value={years.join(", ") || "—"} />
      </div>

      {/* Import instructions */}
      <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
        <div className="px-4 py-2.5 border-b border-dash-border">
          <h2 className="text-[11px] font-ui font-semibold uppercase tracking-wider text-dash-text-secondary">How to Import</h2>
        </div>
        <div className="p-4 space-y-3">
          <Step n={1} title="Export from BigTime">
            Go to BigTime → Reports → Time Reports. Export as CSV. The file should have columns:
            <code className="ml-1 text-dash-accent font-mono text-[11px]">Project, Staff Member, Date, Input, N/C, Notes, Labor Rate, Labor Cost</code>
          </Step>
          <Step n={2} title="Run the import script">
            <pre className="mt-1 bg-dash-surface-sunken rounded p-3 text-[11px] font-mono text-dash-text-secondary overflow-x-auto">{`# Local D1 (development)
python import_bigtime.py path/to/export.csv --year 2026

# Remote Cloudflare D1 (production)
python import_bigtime.py path/to/export.csv --year 2026 --remote`}</pre>
            <p className="text-[11px] text-dash-text-muted mt-1">
              The script automatically applies the N/C reclassification rules and matches each person against the roster.
            </p>
          </Step>
          <Step n={3} title="Import roster (first time or when rates change)">
            <pre className="mt-1 bg-dash-surface-sunken rounded p-3 text-[11px] font-mono text-dash-text-secondary overflow-x-auto">{`python import_bigtime.py --roster "3.2026 Labor Analysis - PS & R&D.xlsx" --remote`}</pre>
          </Step>
          <Step n={4} title="Verify">
            The table below updates automatically after each import. Check that row counts and costs look right before running reports.
          </Step>
        </div>
      </div>

      {/* Monthly Allocation Overrides */}
      <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
        <div className="px-4 py-2.5 border-b border-dash-border">
          <h2 className="text-[11px] font-ui font-semibold uppercase tracking-wider text-dash-text-secondary">Monthly Allocation Overrides — enCompass R&D</h2>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-dash-text-secondary">
            These people default to <strong>100% monthly rate</strong> regardless of BigTime hours.
            Uncheck anyone who should use actual BigTime hours for this month (e.g., hired mid-month, partial month).
          </p>

          {/* Month / Year selector */}
          <form method="GET" className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-dash-text-muted font-ui">Period:</label>
            <select
              name="oy"
              defaultValue={overrideYear}
              className="bg-dash-surface-raised border border-dash-border rounded px-2 py-1 text-xs text-dash-text font-ui"
            >
              {(years.length > 0 ? years : [2026]).map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <select
              name="om"
              defaultValue={overrideMonth}
              className="bg-dash-surface-raised border border-dash-border rounded px-2 py-1 text-xs text-dash-text font-ui"
            >
              {MONTH_LABELS.map((l, i) => (
                <option key={i + 1} value={i + 1}>{l}</option>
              ))}
            </select>
            <button
              type="submit"
              className="px-3 py-1 text-xs font-ui bg-dash-accent text-white rounded hover:opacity-90"
            >
              Load
            </button>
          </form>

          {encRDPeople.length === 0 ? (
            <p className="text-xs text-dash-text-muted italic">
              No 100% allocation people found. Import the roster first.
            </p>
          ) : (
            <Form
              method="POST"
              action={`?oy=${overrideYear}&om=${overrideMonth}`}
              className="space-y-3"
            >
              <input type="hidden" name="year"       value={overrideYear} />
              <input type="hidden" name="month"      value={overrideMonth} />
              <input type="hidden" name="allPeople"  value={allPeopleJson} />

              <div className="border border-dash-border rounded overflow-hidden">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-dash-border bg-dash-surface-raised">
                      <th className="text-left py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px] w-8">100%</th>
                      <th className="text-left py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Name</th>
                      <th className="text-left py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Company</th>
                      <th className="text-left py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {encRDPeople.map((person, i) => (
                      <tr key={person.staff_member} className={i % 2 === 0 ? "" : "bg-dash-surface-raised/40"}>
                        <td className="py-2 px-3 text-center">
                          <input
                            type="checkbox"
                            name={`override||${person.staff_member}||Enc R&D`}
                            value="1"
                            defaultChecked={isChecked(person.staff_member)}
                            className="w-3.5 h-3.5 accent-dash-accent"
                          />
                        </td>
                        <td className="py-2 px-3 text-dash-text font-mono">{person.staff_member}</td>
                        <td className="py-2 px-3 text-dash-text-secondary">{person.company}</td>
                        <td className="py-2 px-3">
                          <Badge
                            label={person.sub_category ?? "—"}
                            variant={person.company === "3Pillar" ? "blue" : person.company === "Testing Xperts" ? "purple" : "gray"}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-ui font-medium bg-dash-accent text-white rounded hover:opacity-90"
                >
                  Save Overrides for {MONTH_LABELS[overrideMonth - 1]}-{String(overrideYear).slice(-2)}
                </button>
                <p className="text-[11px] text-dash-text-muted">
                  Checked = use fixed monthly rate · Unchecked = use actual BigTime hours
                </p>
              </div>
            </Form>
          )}
        </div>
      </div>

      {/* N/C rules reference */}
      <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
        <div className="px-4 py-2.5 border-b border-dash-border">
          <h2 className="text-[11px] font-ui font-semibold uppercase tracking-wider text-dash-text-secondary">N/C Classification Rules</h2>
        </div>
        <div className="p-3">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-dash-border">
                <th className="text-left py-1.5 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Project (exact match)</th>
                <th className="text-right py-1.5 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Bucket</th>
              </tr>
            </thead>
            <tbody>
              {RULES.map((r, i) => (
                <tr key={i} className={i % 2 === 0 ? "" : "bg-dash-surface-raised/40"}>
                  <td className="py-1.5 px-3 font-mono text-[11px] text-dash-text-secondary truncate max-w-[640px]">{r.pattern}</td>
                  <td className="py-1.5 px-3 text-right">
                    <Badge label={r.bucket} variant={NC_BADGE[r.bucket] ?? "gray"} />
                  </td>
                </tr>
              ))}
              <tr className="bg-dash-surface-raised/40">
                <td className="py-1.5 px-3 font-mono text-[11px] text-dash-text-muted italic">Everything else</td>
                <td className="py-1.5 px-3 text-right"><Badge label="Chargeable" variant="green" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Data summary by period */}
      {periodKeys.length > 0 && (
        <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
          <div className="px-4 py-2.5 border-b border-dash-border">
            <h2 className="text-[11px] font-ui font-semibold uppercase tracking-wider text-dash-text-secondary">Imported Data Summary</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-dash-border">
                  <th className="text-left py-2 px-4 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Period</th>
                  <th className="text-left py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Bucket</th>
                  <th className="text-right py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Rows</th>
                  <th className="text-right py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Hours</th>
                  <th className="text-right py-2 px-4 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">Cost</th>
                </tr>
              </thead>
              <tbody>
                {periodKeys.map((key) => {
                  const [yr, mo] = key.split("-").map(Number);
                  const rows = byYearMonth[key];
                  return rows.map((row, j) => (
                    <tr key={`${key}-${j}`} className={j % 2 === 0 ? "bg-dash-surface" : "bg-dash-surface-raised"}>
                      {j === 0 && (
                        <td rowSpan={rows.length} className="py-2 px-4 font-ui text-dash-text font-medium align-top">
                          {MONTH_LABELS[mo - 1]}-{String(yr).slice(-2)}
                        </td>
                      )}
                      <td className="py-1.5 px-3">
                        <Badge label={row.nc_mapped} variant={NC_BADGE[row.nc_mapped] ?? "gray"} />
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono text-dash-text-secondary">{row.row_count.toLocaleString()}</td>
                      <td className="py-1.5 px-3 text-right font-mono text-dash-text-secondary">{formatHours(row.total_hours)}</td>
                      <td className="py-1.5 px-4 text-right font-mono text-dash-text">{formatCurrencyFull(row.total_cost)}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {periodKeys.length === 0 && (
        <div className="bg-dash-surface rounded-lg border border-dash-border p-8 text-center">
          <p className="text-dash-text-muted font-ui text-sm">No data imported yet.</p>
          <p className="text-dash-text-muted text-xs mt-1">Run the import script above to get started.</p>
        </div>
      )}
    </div>
  );
}

const RULES = [
  { pattern: "Radix - Research and Development Project | Radix - Research and Development Project:Radix - Research and Development Project", bucket: "R&D" },
  { pattern: "Radix R&D - Telco. | Radix R&D - Telco.:Radix R&D - Telco.", bucket: "R&D" },
  { pattern: "Mango Core | Mango Core:Mango Core", bucket: "R&D" },
  { pattern: "enCompass | Compass Datacenters:enCompass", bucket: "Enc R&D" },
  { pattern: "CenterSquare errProof Implementation | Centersquare Data Centers:CenterSquare errProof Implementation", bucket: "Enc R&D" },
  { pattern: "enCompass Platform | Compass Datacenters:enCompass Platform", bucket: "Enc R&D" },
  { pattern: "Radix - Overhead Costs | Radix - Overhead Costs:Radix - Overhead Costs", bucket: "OH" },
];

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-dash-surface rounded-lg border border-dash-border p-3.5 flex flex-col gap-1 min-w-[140px] flex-1">
      <p className="text-[10px] font-ui font-medium text-dash-text-secondary uppercase tracking-[0.12em]">{label}</p>
      <p className="text-[22px] font-heading font-semibold text-dash-text">{value}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-dash-accent-subtle text-dash-accent text-[11px] font-ui font-semibold flex items-center justify-center mt-0.5">
        {n}
      </div>
      <div>
        <p className="font-ui font-medium text-dash-text text-xs">{title}</p>
        <div className="text-xs text-dash-text-secondary mt-0.5">{children}</div>
      </div>
    </div>
  );
}
