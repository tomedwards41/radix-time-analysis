import type { Route } from "./+types/radix-rd";
import { requireAccess } from "~/lib/auth";
import {
  getRoster, getTaxBeneRates, getVendorInvoices,
  getPersonDetail, getAvailableYears,
  getRateHistory, getAllMonthlyOverridesForYear,
} from "~/lib/queries";
import { computeRadixRD, sumField, resolvePersonCosts, aggregateToCategories } from "~/lib/computations";
import {
  formatCurrencyFull, formatCurrencyAccounting, formatPercent, formatHours, MONTH_LABELS,
} from "~/lib/formatters";
import MetricCard from "~/components/ui/MetricCard";
import ChartWrapper from "~/components/charts/ChartWrapper";
import { CHART_COLORS, CHART_DEFAULTS } from "~/lib/echarts-theme";
import type { EChartsOption } from "echarts";

export function meta() {
  return [{ title: "Radix R&D | Labor Analysis" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  await requireAccess(env.AUTH, request);

  const years = await getAvailableYears(env.DB);
  const year = years[0] ?? 2026;

  const [personRaw, rates, invoices, roster, rateHistory, overrides] = await Promise.all([
    getPersonDetail(env.DB, "R&D", year),
    getTaxBeneRates(env.DB, year),
    getVendorInvoices(env.DB, year),
    getRoster(env.DB),
    getRateHistory(env.DB),
    getAllMonthlyOverridesForYear(env.DB, year),
  ]);

  const personRows = resolvePersonCosts(personRaw, roster, rateHistory, overrides, "R&D");
  const laborRows  = aggregateToCategories(personRows);
  const monthly = computeRadixRD(laborRows, rates, invoices, year);
  const ytdMonth = Math.max(...monthly.filter((m) => m.total_cip > 0).map((m) => m.month), 0);

  return { monthly, personRows, year, ytdMonth };
}

export default function RadixRDRoute({ loaderData }: Route.ComponentProps) {
  const { monthly, personRows, year, ytdMonth } = loaderData;

  const activeMonths = monthly.filter((m) => m.total_cip > 0);
  const ytdCIP     = sumField(activeMonths, "total_cip");
  const ytdHours   = sumField(activeMonths, "total_hours");
  const ytdW2      = sumField(activeMonths, "cr_rd_comp");
  const ytdVendors = sumField(activeMonths, "cr_innoscale") + sumField(activeMonths, "cr_powerbi");

  const chartOption: EChartsOption = {
    ...CHART_DEFAULTS,
    tooltip: {
      ...CHART_DEFAULTS.tooltip,
      formatter: (params: unknown) => {
        const p = params as { name: string; seriesName: string; value: number }[];
        const lines = p.map((x) => `<div>${x.seriesName}: <b>${formatCurrencyFull(x.value)}</b></div>`);
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
      axisLabel: { color: "#64748B", fontSize: 10, formatter: (v: number) => `$${(v / 1000).toFixed(0)}K` },
      splitLine: CHART_DEFAULTS.splitLine,
    },
    series: [
      {
        name: "W-2 R&D (grossed)",
        type: "bar", stack: "total",
        data: monthly.map((m) => m.cr_rd_comp),
        itemStyle: { color: CHART_COLORS.primary },
      },
      {
        name: "Subs (non-3Pillar)",
        type: "bar", stack: "total",
        data: monthly.map((m) => m.cr_rd_subs),
        itemStyle: { color: CHART_COLORS.info },
      },
      {
        name: "3Pillar",
        type: "bar", stack: "total",
        data: monthly.map((m) => m.cr_3pillar),
        itemStyle: { color: CHART_COLORS.warning },
      },
      {
        name: "Vendors",
        type: "bar", stack: "total",
        data: monthly.map((m) => m.cr_innoscale + m.cr_powerbi),
        itemStyle: { color: CHART_COLORS.gray },
      },
    ],
  };

  const peopleByMonth: Record<string, Record<number, { hours: number; cost: number }>> = {};
  for (const r of personRows) {
    if (!peopleByMonth[r.staff_member]) peopleByMonth[r.staff_member] = {};
    if (!peopleByMonth[r.staff_member][r.month]) peopleByMonth[r.staff_member][r.month] = { hours: 0, cost: 0 };
    peopleByMonth[r.staff_member][r.month].hours += r.hours ?? 0;
    peopleByMonth[r.staff_member][r.month].cost  += r.labor_cost ?? 0;
  }
  const people = Object.keys(peopleByMonth).sort();
  const MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12];

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="text-lg font-heading font-semibold text-dash-text">Radix R&D</h1>
        <p className="text-xs text-dash-text-muted font-ui">Construction in Process — {year} · YTD through {MONTH_LABELS[(ytdMonth || 1) - 1]}</p>
      </div>

      <div className="flex gap-2.5 flex-wrap">
        <MetricCard title="YTD CIP"       value={formatCurrencyFull(ytdCIP)}     />
        <MetricCard title="YTD W-2 R&D"  value={formatCurrencyFull(ytdW2)}      subtitle="incl. taxes & benes" />
        <MetricCard title="YTD Vendors"   value={formatCurrencyFull(ytdVendors)} subtitle="Innoscale + Power BI" />
        <MetricCard title="YTD Hours"     value={formatHours(ytdHours)}          subtitle="R&D allocated" />
      </div>

      <ChartWrapper option={chartOption} height={260} />

      <Section title="Labor Costs (excl. taxes / benes)">
        <MonthlyTable
          year={year}
          rows={[
            { label: "W-2 — R&D",      values: monthly.map((m) => m.w2_rd) },
            { label: "Sub — R&D",      values: monthly.map((m) => m.sub_rd) },
            { label: "Sub — 3Pillar",  values: monthly.map((m) => m.sub_3pillar) },
          ]}
          totalRow={{ label: "Subtotal Labor", values: monthly.map((m) => m.subtotal_labor) }}
          extraRow={{ label: "PR Tax & Bene's %", values: monthly.map((m) => formatPercent(m.tax_bene_rate)), isText: true }}
        />
      </Section>

      <Section title="Vendors">
        <MonthlyTable
          year={year}
          rows={[
            { label: "Innoscale", values: monthly.map((m) => m.vendor_innoscale) },
            { label: "Power BI",  values: monthly.map((m) => m.vendor_powerbi)   },
          ]}
          totalRow={{ label: "Subtotal Vendor Invoices", values: monthly.map((m) => m.vendor_innoscale + m.vendor_powerbi) }}
        />
      </Section>

      <Section title="Journal Entry (incl. taxes & benes)">
        <MonthlyTable
          year={year}
          rows={[
            { label: "Construction in Process",       values: monthly.map((m) =>  m.total_cip),      bold: true },
            { label: "  R&D Compensation",            values: monthly.map((m) => -m.cr_rd_comp) },
            { label: "  R&D Subcontractors",          values: monthly.map((m) => -m.cr_rd_subs) },
            { label: "  R&D Subcontractors — 3Pillar",values: monthly.map((m) => -m.cr_3pillar)  },
            { label: "  R&D Subs — Innoscale",        values: monthly.map((m) => -m.cr_innoscale) },
            { label: "  G&A Software — BI Reports",   values: monthly.map((m) => -m.cr_powerbi)  },
          ]}
        />
      </Section>

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
          </table>
        </div>
      </Section>
    </div>
  );
}

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

interface TableRow { label: string; values: (number | string)[]; bold?: boolean; isText?: boolean; }

function MonthlyTable({ year, rows, totalRow, extraRow }: {
  year: number; rows: TableRow[]; totalRow?: TableRow; extraRow?: TableRow & { isText?: boolean };
}) {
  const ytdCalc = (vals: (number | string)[]) => vals.reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-dash-border">
            <th className="text-left py-1.5 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px] w-52" />
            {MONTH_LABELS.map((l) => (
              <th key={l} className="text-right py-1.5 px-2 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">{l}-{String(year).slice(-2)}</th>
            ))}
            <th className="text-right py-1.5 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px]">YTD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? "" : "bg-dash-surface-raised/40"}>
              <td className={`py-1.5 px-3 ${row.bold ? "font-semibold text-dash-text" : "text-dash-text-secondary"}`}>{row.label}</td>
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
              {extraRow.values.map((v, j) => <td key={j} className="py-1.5 px-2 text-right font-mono text-dash-text-muted">{String(v)}</td>)}
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
              <td className="py-2 px-3 text-right font-mono text-dash-text">{formatCurrencyFull(ytdCalc(totalRow.values))}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
