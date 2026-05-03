import type { Route } from "./+types/ps";
import { requireAccess } from "~/lib/auth";
import {
  getRoster, getTaxBeneRates, getVendorInvoices,
  getPersonDetail, getAvailableYears,
  getRateHistory, getAllMonthlyOverridesForYear,
} from "~/lib/queries";
import {
  computePS, sumField, MONTHS,
  resolvePersonCosts, aggregateToCategories,
} from "~/lib/computations";
import {
  formatCurrencyFull, formatCurrencyAccounting, formatPercent, formatHours, MONTH_LABELS,
} from "~/lib/formatters";
import MetricCard from "~/components/ui/MetricCard";
import ChartWrapper from "~/components/charts/ChartWrapper";
import { CHART_COLORS, CHART_DEFAULTS } from "~/lib/echarts-theme";
import type { EChartsOption } from "echarts";

export function meta() {
  return [{ title: "Professional Services | Labor Analysis" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  await requireAccess(env.AUTH, request);

  const years = await getAvailableYears(env.DB);
  const year = years[0] ?? 2026;

  const [personRaw, rates, invoices, roster, rateHistory, overrides] = await Promise.all([
    getPersonDetail(env.DB, "Chargeable", year),
    getTaxBeneRates(env.DB, year),
    getVendorInvoices(env.DB, year),
    getRoster(env.DB),
    getRateHistory(env.DB),
    getAllMonthlyOverridesForYear(env.DB, year),
  ]);

  const personRows = resolvePersonCosts(personRaw, roster, rateHistory, overrides, "Chargeable");
  const laborRows  = aggregateToCategories(personRows);
  const monthly = computePS(laborRows, rates, year);
  const ytdMonth = Math.max(...monthly.filter((m) => m.total_cos > 0).map((m) => m.month), 0);

  return { monthly, personRows, year, ytdMonth };
}

export default function PSRoute({ loaderData }: Route.ComponentProps) {
  const { monthly, personRows, year, ytdMonth } = loaderData;

  const activeMonths = monthly.filter((m) => m.total_cos > 0);
  const ytdCOS    = sumField(activeMonths, "total_cos");
  const ytdHours  = sumField(activeMonths, "total_hours");
  const ytdW2     = sumField(activeMonths, "cos_labor");
  const ytdSubs   = sumField(activeMonths, "cos_subs");

  // Chart: monthly COS split W-2 vs Subs
  const chartOption: EChartsOption = {
    ...CHART_DEFAULTS,
    tooltip: {
      ...CHART_DEFAULTS.tooltip,
      formatter: (params: unknown) => {
        const p = params as { name: string; seriesName: string; value: number }[];
        const lines = p.map(
          (x) => `<div>${x.seriesName}: <b>${formatCurrencyFull(x.value)}</b></div>`
        );
        return `<div class="font-ui text-xs"><b>${p[0]?.name}</b>${lines.join("")}</div>`;
      },
    },
    legend: { top: 8, textStyle: { color: "#94A3B8", fontSize: 11 } },
    xAxis: {
      type: "category",
      data: MONTH_LABELS.map((l) => `${l}-${String(year).slice(-2)}`),
      axisLine: CHART_DEFAULTS.axisLine,
      axisLabel: { color: "#64748B", fontSize: 10 },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: "#64748B", fontSize: 10,
        formatter: (v: number) => `$${(v / 1000).toFixed(0)}K`,
      },
      splitLine: CHART_DEFAULTS.splitLine,
    },
    series: [
      {
        name: "W-2 Labor (grossed)",
        type: "bar",
        stack: "total",
        data: monthly.map((m) => m.cos_labor),
        itemStyle: { color: CHART_COLORS.barBlue },
      },
      {
        name: "Subcontractors",
        type: "bar",
        stack: "total",
        data: monthly.map((m) => m.cos_subs),
        itemStyle: { color: CHART_COLORS.warning },
      },
    ],
  };

  // Group people by company for the detail table
  const peopleByMonth: Record<string, Record<number, { hours: number; cost: number }>> = {};
  for (const r of personRows) {
    if (!peopleByMonth[r.staff_member]) peopleByMonth[r.staff_member] = {};
    if (!peopleByMonth[r.staff_member][r.month]) peopleByMonth[r.staff_member][r.month] = { hours: 0, cost: 0 };
    peopleByMonth[r.staff_member][r.month].hours += r.hours ?? 0;
    peopleByMonth[r.staff_member][r.month].cost  += r.labor_cost ?? 0;
  }

  const people = Object.keys(peopleByMonth).sort();

  return (
    <div className="p-4 space-y-4">
      {/* Page header */}
      <div>
        <h1 className="text-lg font-heading font-semibold text-dash-text">Radix Professional Services</h1>
        <p className="text-xs text-dash-text-muted font-ui">Cost of Sales — {year} · YTD through {MONTH_LABELS[(ytdMonth || 1) - 1]}</p>
      </div>

      {/* KPI row */}
      <div className="flex gap-2.5 flex-wrap">
        <MetricCard title="YTD COS"        value={formatCurrencyFull(ytdCOS)}   />
        <MetricCard title="YTD W-2 Labor"  value={formatCurrencyFull(ytdW2)}    subtitle="incl. taxes & benes" />
        <MetricCard title="YTD Subs"       value={formatCurrencyFull(ytdSubs)}  />
        <MetricCard title="YTD Hours"      value={formatHours(ytdHours)}        subtitle="chargeable" />
      </div>

      {/* Monthly chart */}
      <ChartWrapper option={chartOption} height={260} />

      {/* Labor cost summary table */}
      <Section title="Labor Costs (excl. taxes / benes)">
        <MonthlyTable
          year={year}
          rows={[
            { label: "W-2 — Ops",     values: monthly.map((m) => m.w2_ops) },
            { label: "W-2 — R&D",     values: monthly.map((m) => m.w2_rd) },
            { label: "W-2 — G&A",     values: monthly.map((m) => m.w2_ga) },
            { label: "Sub — Ops",     values: monthly.map((m) => m.sub_ops) },
            { label: "Sub — R&D",     values: monthly.map((m) => m.sub_rd) },
          ]}
          totalRow={{ label: "Subtotal Labor", values: monthly.map((m) => m.subtotal_labor) }}
          extraRow={{ label: "PR Tax & Bene's %", values: monthly.map((m) => formatPercent(m.tax_bene_rate)), isText: true }}
        />
      </Section>

      {/* Journal entry */}
      <Section title="Journal Entry (incl. taxes & benes)">
        <MonthlyTable
          year={year}
          rows={[
            { label: "Cost of Labor — COS",     values: monthly.map((m) =>  m.cos_labor),    bold: true },
            { label: "Subcontractors — COS",    values: monthly.map((m) =>  m.cos_subs),     bold: true },
            { label: "  Ops Compensation",      values: monthly.map((m) => -m.cr_ops_comp) },
            { label: "  R&D Compensation",      values: monthly.map((m) => -m.cr_rd_comp)  },
            { label: "  G&A Compensation",      values: monthly.map((m) => -m.cr_ga_comp)  },
            { label: "  Ops Subcontractors",    values: monthly.map((m) => -m.cr_ops_subs) },
            { label: "  R&D Subcontractors",    values: monthly.map((m) => -m.cr_rd_subs)  },
          ]}
          totalRow={{ label: "Net (check — should be $0)", values: monthly.map((m) => m.total_cos - m.cr_ops_comp - m.cr_rd_comp - m.cr_ga_comp - m.cr_ops_subs - m.cr_rd_subs) }}
        />
      </Section>

      {/* Per-person detail */}
      <Section title="Detail by Staff Member">
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="border-b border-dash-border">
                <th className="text-left py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px] w-48">Name</th>
                {MONTH_LABELS.map((l, i) => (
                  <th key={i} className="text-right py-2 px-2 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">{l}</th>
                ))}
                <th className="text-right py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">YTD</th>
              </tr>
            </thead>
            <tbody>
              {people.map((name, i) => {
                const row = peopleByMonth[name];
                const ytd = Object.values(row).reduce((s, v) => s + v.cost, 0);
                return (
                  <tr key={name} className={i % 2 === 0 ? "bg-dash-surface" : "bg-dash-surface-raised"}>
                    <td className="py-1.5 px-3 text-dash-text truncate max-w-[192px]">{name}</td>
                    {MONTHS.map((m) => (
                      <td key={m} className="py-1.5 px-2 text-right text-dash-text-secondary">
                        {row[m]?.cost ? formatCurrencyAccounting(row[m].cost) : "—"}
                      </td>
                    ))}
                    <td className="py-1.5 px-3 text-right font-semibold text-dash-text">{formatCurrencyFull(ytd)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-dash-border font-semibold bg-dash-surface-raised">
                <td className="py-2 px-3 text-dash-text">Total</td>
                {MONTHS.map((m) => {
                  const total = people.reduce((s, name) => s + (peopleByMonth[name][m]?.cost ?? 0), 0);
                  return (
                    <td key={m} className="py-2 px-2 text-right text-dash-text">
                      {total ? formatCurrencyAccounting(total) : "—"}
                    </td>
                  );
                })}
                <td className="py-2 px-3 text-right text-dash-text">
                  {formatCurrencyFull(people.reduce((s, name) => s + Object.values(peopleByMonth[name]).reduce((a, v) => a + v.cost, 0), 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
      <div className="px-4 py-2.5 border-b border-dash-border">
        <h2 className="text-[11px] font-ui font-semibold uppercase tracking-wider text-dash-text-secondary">{title}</h2>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

interface TableRow {
  label: string;
  values: (number | string)[];
  bold?: boolean;
  isText?: boolean;
}

function MonthlyTable({
  year,
  rows,
  totalRow,
  extraRow,
}: {
  year: number;
  rows: TableRow[];
  totalRow?: TableRow;
  extraRow?: TableRow & { isText?: boolean };
}) {
  const ytdCalc = (vals: (number | string)[]) =>
    vals.reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-dash-border">
            <th className="text-left py-1.5 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px] w-44" />
            {MONTH_LABELS.map((l) => (
              <th key={l} className="text-right py-1.5 px-2 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">{l}-{String(year).slice(-2)}</th>
            ))}
            <th className="text-right py-1.5 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">YTD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? "" : "bg-dash-surface-raised/40"}>
              <td className={`py-1.5 px-3 ${row.bold ? "font-semibold text-dash-text" : "text-dash-text-secondary"}`}>
                {row.label}
              </td>
              {row.values.map((v, j) => (
                <td key={j} className={`py-1.5 px-2 text-right font-mono ${row.bold ? "text-dash-text" : "text-dash-text-secondary"}`}>
                  {row.isText ? String(v) : formatCurrencyAccounting(typeof v === "number" ? v : 0)}
                </td>
              ))}
              <td className="py-1.5 px-3 text-right font-mono text-dash-text-secondary">
                {row.isText ? "" : formatCurrencyFull(ytdCalc(row.values))}
              </td>
            </tr>
          ))}
          {extraRow && (
            <tr className="border-t border-dash-border-divider">
              <td className="py-1.5 px-3 text-dash-text-muted italic">{extraRow.label}</td>
              {extraRow.values.map((v, j) => (
                <td key={j} className="py-1.5 px-2 text-right font-mono text-dash-text-muted">{String(v)}</td>
              ))}
              <td />
            </tr>
          )}
          {totalRow && (
            <tr className="border-t border-dash-border font-semibold">
              <td className="py-2 px-3 text-dash-text">{totalRow.label}</td>
              {totalRow.values.map((v, j) => (
                <td key={j} className="py-2 px-2 text-right font-mono text-dash-text">
                  {formatCurrencyAccounting(typeof v === "number" ? v : 0)}
                </td>
              ))}
              <td className="py-2 px-3 text-right font-mono text-dash-text">
                {formatCurrencyFull(ytdCalc(totalRow.values))}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
