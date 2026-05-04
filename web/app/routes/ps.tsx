import React from "react";
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
  const activeMonthNums = new Set(activeMonths.map((m) => m.month));
  const ytdW2   = sumField(activeMonths, "cos_labor");
  const ytdSubs = sumField(activeMonths, "cos_subs");

  const ytdW2Hours    = personRows.filter((r) => r.emp_type === "W-2"  && activeMonthNums.has(r.month)).reduce((s, r) => s + (r.hours ?? 0), 0);
  const ytdSubHours   = personRows.filter((r) => r.emp_type === "Sub"  && activeMonthNums.has(r.month)).reduce((s, r) => s + (r.hours ?? 0), 0);
  const ytdTotalHours = ytdW2Hours + ytdSubHours;
  const w2PerHour      = ytdW2Hours      > 0 ? ytdW2  / ytdW2Hours      : null;
  const subPerHour     = ytdSubHours     > 0 ? ytdSubs / ytdSubHours     : null;
  const blendedPerHour = ytdTotalHours   > 0 ? (ytdW2 + ytdSubs) / ytdTotalHours : null;

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

  // Build grouping: company → dept → person → month
  type MonthMap = Record<number, { hours: number; cost: number }>;
  const grouped: Record<string, Record<string, Record<string, MonthMap>>> = {};

  for (const r of personRows) {
    const co   = r.company ?? "Unknown";
    const dept = r.dept    ?? "Unknown";
    const name = r.staff_member;
    if (!grouped[co])           grouped[co] = {};
    if (!grouped[co][dept])     grouped[co][dept] = {};
    if (!grouped[co][dept][name]) grouped[co][dept][name] = {};
    const mm = grouped[co][dept][name];
    if (!mm[r.month]) mm[r.month] = { hours: 0, cost: 0 };
    mm[r.month].hours += r.hours      ?? 0;
    mm[r.month].cost  += r.labor_cost ?? 0;
  }

  const coOrder = ["Radix", ...Object.keys(grouped).filter((c) => c !== "Radix").sort()];

  const mCost  = (mm: MonthMap, m: number) => mm[m]?.cost ?? 0;
  const ytdMM  = (mm: MonthMap) => Object.values(mm).reduce((s, v) => s + v.cost, 0);
  const deptMC = (dd: Record<string, MonthMap>, m: number) =>
    Object.values(dd).reduce((s, mm) => s + mCost(mm, m), 0);
  const coMC   = (cd: Record<string, Record<string, MonthMap>>, m: number) =>
    Object.values(cd).reduce((s, dd) => s + deptMC(dd, m), 0);
  const grandMC = (m: number) =>
    coOrder.filter((co) => grouped[co]).reduce((s, co) => s + coMC(grouped[co], m), 0);

  return (
    <div className="p-4 space-y-4">
      {/* Page header */}
      <div>
        <h1 className="text-lg font-heading font-semibold text-dash-text">Radix Professional Services</h1>
        <p className="text-xs text-dash-text-muted font-ui">Cost of Sales — {year} · YTD through {MONTH_LABELS[(ytdMonth || 1) - 1]}</p>
      </div>

      {/* KPI row */}
      <div className="flex gap-2.5 flex-wrap">
        {/* YTD Labor Cost */}
        <div className="bg-dash-surface rounded-lg border border-dash-border p-3.5 flex flex-col gap-1 min-w-[140px] flex-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-white/20 cursor-default">
          <p className="text-[10px] font-ui font-medium text-dash-text-secondary uppercase tracking-[0.12em]">YTD Labor Cost</p>
          <div className="flex flex-col flex-1 justify-center">
            <div>
              <p className="text-[15px] font-heading font-semibold text-dash-text leading-tight">{formatCurrencyFull(ytdW2)}</p>
              <p className="text-[10px] text-dash-text-muted">W-2 incl. T&amp;B</p>
            </div>
            <div className="mt-0.5">
              <p className="text-[15px] font-heading font-semibold text-dash-text leading-tight">{formatCurrencyFull(ytdSubs)}</p>
              <p className="text-[10px] text-dash-text-muted">Contractors</p>
            </div>
            <div className="mt-1 pt-1 border-t border-dash-border">
              <p className="text-[15px] font-heading font-semibold text-dash-accent leading-tight">{formatCurrencyFull(ytdW2 + ytdSubs)}</p>
              <p className="text-[10px] text-dash-text-muted">Total</p>
            </div>
          </div>
        </div>
        {/* YTD Hours */}
        <div className="bg-dash-surface rounded-lg border border-dash-border p-3.5 flex flex-col gap-1 min-w-[140px] flex-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-white/20 cursor-default">
          <p className="text-[10px] font-ui font-medium text-dash-text-secondary uppercase tracking-[0.12em]">YTD Hours</p>
          <div className="flex flex-col flex-1 justify-center">
            <div>
              <p className="text-[15px] font-heading font-semibold text-dash-text leading-tight">{formatHours(ytdW2Hours)}</p>
              <p className="text-[10px] text-dash-text-muted">W-2</p>
            </div>
            <div className="mt-0.5">
              <p className="text-[15px] font-heading font-semibold text-dash-text leading-tight">{formatHours(ytdSubHours)}</p>
              <p className="text-[10px] text-dash-text-muted">Contractors</p>
            </div>
            <div className="mt-1 pt-1 border-t border-dash-border">
              <p className="text-[15px] font-heading font-semibold text-dash-accent leading-tight">{formatHours(ytdTotalHours)}</p>
              <p className="text-[10px] text-dash-text-muted">Total</p>
            </div>
          </div>
        </div>
        {/* Cost per Hour */}
        <div className="bg-dash-surface rounded-lg border border-dash-border p-3.5 flex flex-col gap-1 min-w-[140px] flex-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-white/20 cursor-default">
          <p className="text-[10px] font-ui font-medium text-dash-text-secondary uppercase tracking-[0.12em]">Cost per Hour</p>
          <div className="flex flex-col flex-1 justify-center">
            <div>
              <p className="text-[15px] font-heading font-semibold text-dash-text leading-tight">
                {w2PerHour != null ? formatCurrencyFull(w2PerHour) : "—"}
              </p>
              <p className="text-[10px] text-dash-text-muted">W-2 incl. T&amp;B</p>
            </div>
            <div className="mt-0.5">
              <p className="text-[15px] font-heading font-semibold text-dash-text leading-tight">
                {subPerHour != null ? formatCurrencyFull(subPerHour) : "—"}
              </p>
              <p className="text-[10px] text-dash-text-muted">Contractors</p>
            </div>
            <div className="mt-1 pt-1 border-t border-dash-border">
              <p className="text-[15px] font-heading font-semibold text-dash-accent leading-tight">
                {blendedPerHour != null ? formatCurrencyFull(blendedPerHour) : "—"}
              </p>
              <p className="text-[10px] text-dash-text-muted">Blended</p>
            </div>
          </div>
        </div>
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
          footerRows={[
            { label: "PR Tax & Bene's %",     values: monthly.map((m) => formatPercent(m.tax_bene_rate)), isText: true },
            { label: "Payroll Taxes & Benes", values: monthly.map((m) => (m.w2_ops + m.w2_rd + m.w2_ga) * m.tax_bene_rate), bold: true },
            { label: "Total Costs",           values: monthly.map((m) => m.total_cos), bold: true },
          ]}
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
              {coOrder.filter((co) => grouped[co]).map((co) => {
                const coData = grouped[co];
                const depts  = Object.keys(coData).sort();
                const coYTD  = depts.reduce((s, d) => s + Object.values(coData[d]).reduce((s2, mm) => s2 + ytdMM(mm), 0), 0);
                return (
                  <React.Fragment key={co}>
                    {/* Company subtotal row */}
                    <tr className="border-t-2 border-dash-border bg-white/[0.09]">
                      <td className="py-1.5 px-3 font-semibold text-dash-text">{co}</td>
                      {MONTHS.map((m) => {
                        const t = coMC(coData, m);
                        return <td key={m} className="py-1.5 px-2 text-right font-semibold font-mono text-dash-text">{t ? formatCurrencyAccounting(t) : "—"}</td>;
                      })}
                      <td className="py-1.5 px-3 text-right font-semibold font-mono text-dash-text">{formatCurrencyFull(coYTD)}</td>
                    </tr>
                    {depts.map((dept) => {
                      const deptData = coData[dept];
                      const names    = Object.keys(deptData).sort();
                      const deptYTD  = names.reduce((s, n) => s + ytdMM(deptData[n]), 0);
                      return (
                        <React.Fragment key={dept}>
                          {/* Dept subtotal row */}
                          <tr className="bg-white/[0.05]">
                            <td className="py-1 px-3 pl-7 font-medium text-dash-text italic">{dept}</td>
                            {MONTHS.map((m) => {
                              const t = deptMC(deptData, m);
                              return <td key={m} className="py-1 px-2 text-right font-mono text-dash-text">{t ? formatCurrencyAccounting(t) : "—"}</td>;
                            })}
                            <td className="py-1 px-3 text-right font-mono text-dash-text">{formatCurrencyFull(deptYTD)}</td>
                          </tr>
                          {/* Person rows */}
                          {names.map((name, i) => {
                            const mm = deptData[name];
                            return (
                              <tr key={name} className={i % 2 === 0 ? "bg-dash-surface" : "bg-dash-surface-raised/30"}>
                                <td className="py-1.5 px-3 pl-12 text-dash-text-secondary truncate max-w-[192px]">{name}</td>
                                {MONTHS.map((m) => (
                                  <td key={m} className="py-1.5 px-2 text-right font-mono text-dash-text-secondary">
                                    {mm[m]?.cost ? formatCurrencyAccounting(mm[m].cost) : "—"}
                                  </td>
                                ))}
                                <td className="py-1.5 px-3 text-right font-mono text-dash-text-secondary">{formatCurrencyFull(ytdMM(mm))}</td>
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-dash-border font-semibold bg-dash-surface-raised">
                <td className="py-2 px-3 text-dash-text">Grand Total</td>
                {MONTHS.map((m) => {
                  const t = grandMC(m);
                  return <td key={m} className="py-2 px-2 text-right font-mono text-dash-text">{t ? formatCurrencyAccounting(t) : "—"}</td>;
                })}
                <td className="py-2 px-3 text-right font-mono text-dash-text">
                  {formatCurrencyFull(coOrder.filter((co) => grouped[co]).reduce((s, co) => s + Object.values(grouped[co]).reduce((s2, dd) => s2 + Object.values(dd).reduce((s3, mm) => s3 + ytdMM(mm), 0), 0), 0))}
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
  footerRows,
}: {
  year: number;
  rows: TableRow[];
  totalRow?: TableRow;
  footerRows?: (TableRow & { isText?: boolean })[];
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
          {footerRows?.map((row, i) => row.bold ? (
            <tr key={i} className="border-t border-dash-border font-semibold">
              <td className="py-2 px-3 text-dash-text">{row.label}</td>
              {row.values.map((v, j) => (
                <td key={j} className="py-2 px-2 text-right font-mono text-dash-text">
                  {formatCurrencyAccounting(typeof v === "number" ? v : 0)}
                </td>
              ))}
              <td className="py-2 px-3 text-right font-mono text-dash-text">
                {formatCurrencyFull(ytdCalc(row.values))}
              </td>
            </tr>
          ) : (
            <tr key={i} className="border-t border-dash-border-divider">
              <td className="py-1.5 px-3 text-dash-text-muted italic">{row.label}</td>
              {row.values.map((v, j) => (
                <td key={j} className="py-1.5 px-2 text-right font-mono text-dash-text-muted">
                  {row.isText ? String(v) : formatCurrencyAccounting(typeof v === "number" ? v : 0)}
                </td>
              ))}
              <td className="py-1.5 px-3 text-right font-mono text-dash-text-muted">
                {row.isText ? "" : formatCurrencyFull(ytdCalc(row.values))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
