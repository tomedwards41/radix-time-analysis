import React, { useState } from "react";
import type { Route } from "./+types/interco-rd";
import { redirect } from "react-router";
import { requireAccess } from "~/lib/auth";
import {
  getRoster, getTaxBeneRates, getVendorInvoices,
  getPersonDetail, getAvailableYears,
  getRateHistory, getAllMonthlyOverridesForYear,
  getRdAllocations, getRdFeatures, getEncPlatformAllocations,
  upsertRdAllocation, upsertEncPlatformAllocation,
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

  const [personRaw, rates, invoices, roster, rateHistory, overrides, allocations, features, encAllocs] =
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
    ]);

  const personRows  = resolvePersonCosts(personRaw, roster, rateHistory, overrides, "Enc R&D");
  const laborRows   = aggregateToCategories(personRows);
  const encMonthly  = computeEncRD(laborRows, rates, invoices, year);
  const step1       = computeStep1(personRows, allocations, invoices, year);
  const step2       = computeStep2(step1, features, encAllocs, year);

  const ytdMonth = Math.max(...encMonthly.filter((m) => m.cip > 0).map((m) => m.month), 0);

  return { step1, step2, features, allocations, encAllocs, year, ytdMonth };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env;
  await requireAccess(env.AUTH, request);

  const form   = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "save_enc_alloc") {
    const year  = Number(form.get("year"));
    const month = Number(form.get("month"));
    const raw   = JSON.parse(form.get("allocs") as string) as { feature_id: number; pct: number }[];
    for (const { feature_id, pct } of raw) {
      await upsertEncPlatformAllocation(env.DB, feature_id, year, month, pct);
    }
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-dash-surface rounded-lg border border-dash-border">
      <div className="px-4 py-2.5 border-b border-dash-border bg-dash-surface-raised rounded-t-lg">
        <h2 className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-widest">{title}</h2>
      </div>
      {children}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function IntercoRDRoute({ loaderData }: Route.ComponentProps) {
  const { step1, step2, features, allocations, encAllocs, year, ytdMonth } = loaderData;

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

  const [showEncAdmin, setShowEncAdmin]       = useState(false);
  const [showPersonAdmin, setShowPersonAdmin] = useState(false);

  // enc_platform admin: local edits keyed by "feature_id:month"
  const [encEdits, setEncEdits] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const a of encAllocs) { init[`${a.feature_id}:${a.month}`] = String(a.allocation_pct); }
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

  // Months to show in enc admin — months that have labor data
  const adminMonths = ytdMonths.length > 0 ? ytdMonths : [1, 2, 3];

  // Totals per month for enc admin
  const encMonthTotal = (month: number) => {
    let total = 0;
    for (const f of encFeatures) {
      total += parseFloat(encEdits[`${f.id}:${month}`] ?? "0") || 0;
    }
    return total;
  };

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-lg font-heading font-semibold text-dash-text">Interco R&D Invoice</h1>
        <p className="text-xs text-dash-text-muted font-ui">
          enCompass R&D allocation to activity buckets and features — {year} · YTD through {MONTH_LABELS[(ytdMonth || 1) - 1]}
        </p>
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
        <Section title="Step 1 — Bucket Allocation (with 15% Markup)">
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
            <Section key={bucket} title={`Step 2 — ${bucketLabels[bucket]}`}>
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
          <div className="p-4 space-y-4">
            <p className="text-xs text-dash-text-muted font-ui">
              Enter the % of each month's enCompass Platforms bucket allocated to each active feature. Each month's column must total 100%.
            </p>
            {adminMonths.map((month) => {
              const total = encMonthTotal(month);
              const isValid = Math.abs(total - 1.0) < 0.001;
              return (
                <div key={month} className="border border-dash-border rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-dash-surface-raised border-b border-dash-border flex items-center justify-between">
                    <span className="text-[11px] font-ui font-semibold text-dash-text-secondary uppercase tracking-wide">
                      {MONTH_LABELS[month - 1]}-{String(year).slice(-2)}
                    </span>
                    <span className={`text-[10px] font-ui font-semibold ${isValid ? "text-dash-positive" : "text-dash-warning"}`}>
                      Total: {(total * 100).toFixed(1)}%
                    </span>
                  </div>
                  <form method="post" className="p-3">
                    <input type="hidden" name="intent" value="save_enc_alloc" />
                    <input type="hidden" name="year"   value={year} />
                    <input type="hidden" name="month"  value={month} />
                    <div className="space-y-1.5">
                      {encFeatures.map((f) => (
                        <div key={f.id} className="flex items-center gap-3">
                          <label className="text-xs font-ui text-dash-text w-64 truncate">{f.name}</label>
                          <input
                            type="number"
                            step="0.001"
                            min="0"
                            max="1"
                            value={encEdits[`${f.id}:${month}`] ?? "0"}
                            onChange={(e) => setEncEdits((prev) => ({ ...prev, [`${f.id}:${month}`]: e.target.value }))}
                            className="w-24 bg-dash-surface-raised border border-dash-border rounded px-2 py-1 text-xs font-ui text-dash-text text-right focus:outline-none focus:border-dash-accent"
                          />
                          <span className="text-[10px] text-dash-text-muted">
                            {((parseFloat(encEdits[`${f.id}:${month}`] ?? "0") || 0) * 100).toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                    <input
                      type="hidden"
                      name="allocs"
                      value={JSON.stringify(encFeatures.map((f) => ({ feature_id: f.id, pct: parseFloat(encEdits[`${f.id}:${month}`] ?? "0") || 0 })))}
                    />
                    <button
                      type="submit"
                      disabled={!isValid}
                      className="mt-3 px-4 py-1.5 text-xs font-ui font-medium rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-dash-accent/10 text-dash-accent border-dash-accent/30 hover:bg-dash-accent/20"
                    >
                      Save {MONTH_LABELS[month - 1]}
                    </button>
                  </form>
                </div>
              );
            })}
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
        )}
      </div>
    </div>
  );
}
