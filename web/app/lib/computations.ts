import type { TaxBeneRate, VendorInvoice, PersonDetail, RosterEntry, RateHistoryRow, MonthlyOverride } from "./types";

export const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// Standard full-time monthly hours used for 100% allocation people
export const MONTHLY_HOURS_FULL = 173.33;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function taxRate(rates: TaxBeneRate[], year: number, month: number): number {
  return rates.find((r) => r.year === year && r.month === month)?.rate ?? 0;
}

export function vendorTotal(invoices: VendorInvoice[], bucket: string, year: number, month: number): number {
  return invoices
    .filter((v) => v.nc_bucket === bucket && v.year === year && v.month === month)
    .reduce((sum, v) => sum + v.amount, 0);
}

// ── Rate resolution ───────────────────────────────────────────────────────────

// Returns the most recent hourly_rate from history where effective_date ≤ last day of month
export function getRateForMonth(
  rateHistory: RateHistoryRow[],
  name: string,
  year: number,
  month: number
): number | null {
  const lastDay = `${year}-${String(month).padStart(2, "0")}-${new Date(year, month, 0).getDate()}`;
  const hit = rateHistory
    .filter((r) => r.name === name && r.effective_date <= lastDay && r.hourly_rate != null)
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0];
  return hit?.hourly_rate ?? null;
}

// Resolves labor cost for every person using roster hourly rates — BigTime costs are never used.
// Formula: hours × hourly_rate
//   - BT people:   actual BigTime hours × hourly_rate
//   - 100% people: 173.33 hours × hourly_rate (standard full-time month)
// Rate history takes precedence over roster.hourly_rate for mid-year rate changes.
export function resolvePersonCosts(
  rawData: PersonDetail[],
  roster: RosterEntry[],
  rateHistory: RateHistoryRow[],
  allOverrides: MonthlyOverride[],
  ncBucket: string
): PersonDetail[] {
  const rosterMap = new Map(roster.map((r) => [r.name, r]));

  return rawData.map((row) => {
    const person = rosterMap.get(row.staff_member);
    if (!person) return row;

    const override = allOverrides.find(
      (o) =>
        o.staff_member === row.staff_member &&
        o.year === row.year &&
        o.month === row.month &&
        o.nc_bucket === ncBucket
    );

    // 100% monthly allocation only applies on enCompass R&D; all other tabs use actual hours
    const canUseFullMonth = ncBucket === "Enc R&D";
    const isInPrimaryBucket =
      person.primary_nc_bucket != null && person.primary_nc_bucket === ncBucket;
    const useFullMonth =
      canUseFullMonth &&
      (override != null ? override.use_monthly_rate === 1 : (person.default_alloc === "100%" && isInPrimaryBucket));

    const hourlyRate = getRateForMonth(rateHistory, row.staff_member, row.year, row.month)
      ?? person.hourly_rate
      ?? null;

    if (hourlyRate == null) return row; // no rate on file — leave unchanged

    const hours = useFullMonth ? MONTHLY_HOURS_FULL : (row.hours ?? 0);
    return { ...row, labor_cost: hours * hourlyRate };
  });
}

// Re-aggregates resolved PersonDetail rows into the CategoryRow format expected by computePS/computeRadixRD/computeEncRD
export function aggregateToCategories(
  resolvedRows: PersonDetail[]
): { month: number; sub_category: string; total_cost: number; total_hours: number }[] {
  const map = new Map<string, { month: number; sub_category: string; total_cost: number; total_hours: number }>();

  for (const row of resolvedRows) {
    const sub = row.sub_category ?? `${row.emp_type} - ${row.dept}`;
    const key = `${row.month}::${sub}`;
    const existing = map.get(key);
    if (existing) {
      existing.total_cost  += row.labor_cost ?? 0;
      existing.total_hours += row.hours ?? 0;
    } else {
      map.set(key, { month: row.month, sub_category: sub, total_cost: row.labor_cost ?? 0, total_hours: row.hours ?? 0 });
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => a.month - b.month || a.sub_category.localeCompare(b.sub_category)
  );
}

// ── Category aggregation ──────────────────────────────────────────────────────

interface CategoryRow {
  month: number;
  sub_category: string;
  total_cost: number;
  total_hours: number;
}

function sumBySubcat(rows: CategoryRow[], month: number, ...subcats: string[]): number {
  return rows
    .filter((r) => r.month === month && subcats.includes(r.sub_category))
    .reduce((s, r) => s + (r.total_cost ?? 0), 0);
}

// ── PS (Professional Services / Chargeable) ───────────────────────────────────

export interface PSMonthData {
  month: number;
  w2_ops: number;
  w2_rd: number;
  w2_ga: number;
  sub_ops: number;
  sub_rd: number;
  subtotal_labor: number;
  tax_bene_rate: number;
  // grossed-up
  cos_labor: number;       // W-2 total × (1 + rate)
  cos_subs: number;        // Sub total (no gross-up)
  total_cos: number;
  // journal entry credits
  cr_ops_comp: number;
  cr_rd_comp: number;
  cr_ga_comp: number;
  cr_ops_subs: number;
  cr_rd_subs: number;
  // hours
  total_hours: number;
}

export function computePS(
  rows: CategoryRow[],
  rates: TaxBeneRate[],
  year: number
): PSMonthData[] {
  return MONTHS.map((month) => {
    const w2_ops = sumBySubcat(rows, month, "W-2 - Ops");
    const w2_rd  = sumBySubcat(rows, month, "W-2 - R&D");
    const w2_ga  = sumBySubcat(rows, month, "W-2 - G&A");
    const sub_ops = sumBySubcat(rows, month, "Sub - Ops");
    const sub_rd  = sumBySubcat(rows, month, "Sub - R&D", "Sub - 3Pillar", "Sub - Testing");
    const subtotal_labor = w2_ops + w2_rd + w2_ga + sub_ops + sub_rd;

    const rate = taxRate(rates, year, month);
    const cos_labor = (w2_ops + w2_rd + w2_ga) * (1 + rate);
    const cos_subs  = sub_ops + sub_rd;
    const total_cos = cos_labor + cos_subs;

    const total_hours = rows
      .filter((r) => r.month === month)
      .reduce((s, r) => s + (r.total_hours ?? 0), 0);

    return {
      month,
      w2_ops, w2_rd, w2_ga, sub_ops, sub_rd,
      subtotal_labor,
      tax_bene_rate: rate,
      cos_labor, cos_subs, total_cos,
      cr_ops_comp:  w2_ops * (1 + rate),
      cr_rd_comp:   w2_rd  * (1 + rate),
      cr_ga_comp:   w2_ga  * (1 + rate),
      cr_ops_subs:  sub_ops,
      cr_rd_subs:   sub_rd,
      total_hours,
    };
  });
}

// ── Radix R&D ─────────────────────────────────────────────────────────────────

export interface RadixRDMonthData {
  month: number;
  w2_rd: number;
  sub_rd: number;
  sub_3pillar: number;
  subtotal_labor: number;
  tax_bene_rate: number;
  // grossed-up
  cip: number;
  // vendor
  vendor_innoscale: number;
  vendor_powerbi: number;
  total_cip: number;
  // journal credits
  cr_rd_comp: number;
  cr_rd_subs: number;
  cr_3pillar: number;
  cr_innoscale: number;
  cr_powerbi: number;
  // hours
  total_hours: number;
}

export function computeRadixRD(
  rows: CategoryRow[],
  rates: TaxBeneRate[],
  invoices: VendorInvoice[],
  year: number
): RadixRDMonthData[] {
  return MONTHS.map((month) => {
    const w2_rd      = sumBySubcat(rows, month, "W-2 - R&D");
    const sub_rd     = sumBySubcat(rows, month, "Sub - R&D");
    const sub_3pillar = sumBySubcat(rows, month, "Sub - 3Pillar");
    const subtotal_labor = w2_rd + sub_rd + sub_3pillar;

    const rate = taxRate(rates, year, month);
    const cr_rd_comp = w2_rd * (1 + rate);
    const cr_rd_subs  = sub_rd;
    const cr_3pillar  = sub_3pillar;

    const vendor_innoscale = vendorTotal(invoices, "Radix R&D", year, month);
    const vendor_powerbi   = invoices
      .filter((v) => v.nc_bucket === "Radix R&D" && v.year === year && v.month === month && v.vendor === "Power BI")
      .reduce((s, v) => s + v.amount, 0);
    const innoscale_amt    = invoices
      .filter((v) => v.nc_bucket === "Radix R&D" && v.year === year && v.month === month && v.vendor === "Innoscale")
      .reduce((s, v) => s + v.amount, 0);

    const cip = cr_rd_comp + cr_rd_subs + cr_3pillar;
    const total_cip = cip + innoscale_amt + vendor_powerbi;

    const total_hours = rows
      .filter((r) => r.month === month)
      .reduce((s, r) => s + (r.total_hours ?? 0), 0);

    return {
      month,
      w2_rd, sub_rd, sub_3pillar, subtotal_labor,
      tax_bene_rate: rate,
      cip, vendor_innoscale: innoscale_amt, vendor_powerbi, total_cip,
      cr_rd_comp, cr_rd_subs, cr_3pillar,
      cr_innoscale: innoscale_amt, cr_powerbi: vendor_powerbi,
      total_hours,
    };
  });
}

// ── enCompass R&D ─────────────────────────────────────────────────────────────

export interface EncRDMonthData {
  month: number;
  w2_ops: number;
  w2_rd: number;
  sub_rd_contractors: number;
  sub_3pillar: number;
  sub_testing: number;
  subtotal_labor: number;
  tax_bene_rate: number;
  // grossed-up W-2
  rd_labor_grossed: number;
  // total labor sources (for CIP)
  total_labor_sources: number;
  // vendors
  vendor_innoscale: number;
  vendor_powerbi: number;
  // CIP and intercompany
  cip: number;
  intercompany_invoice: number; // CIP × 1.15
  // journal credits
  cr_rd_labor: number;
  cr_rd_subs: number;
  cr_3pillar: number;
  cr_testing: number;
  cr_innoscale: number;
  cr_powerbi: number;
  // hours
  total_hours: number;
}

export function computeEncRD(
  rows: CategoryRow[],
  rates: TaxBeneRate[],
  invoices: VendorInvoice[],
  year: number
): EncRDMonthData[] {
  return MONTHS.map((month) => {
    const w2_ops = sumBySubcat(rows, month, "W-2 - Ops");
    const w2_rd  = sumBySubcat(rows, month, "W-2 - R&D");
    const sub_rd_contractors = sumBySubcat(rows, month, "Sub - R&D");
    const sub_3pillar = sumBySubcat(rows, month, "Sub - 3Pillar");
    const sub_testing = sumBySubcat(rows, month, "Sub - Testing");
    const subtotal_labor = w2_ops + w2_rd + sub_rd_contractors + sub_3pillar + sub_testing;

    const rate = taxRate(rates, year, month);
    const rd_labor_grossed = (w2_ops + w2_rd) * (1 + rate);

    const total_labor_sources = rd_labor_grossed + sub_rd_contractors + sub_3pillar + sub_testing;

    const innoscale_amt = invoices
      .filter((v) => v.nc_bucket === "Enc R&D" && v.year === year && v.month === month && v.vendor === "Innoscale")
      .reduce((s, v) => s + v.amount, 0);
    const powerbi_amt = invoices
      .filter((v) => v.nc_bucket === "Enc R&D" && v.year === year && v.month === month && v.vendor === "Power BI")
      .reduce((s, v) => s + v.amount, 0);

    const cip = total_labor_sources + innoscale_amt + powerbi_amt;
    const intercompany_invoice = cip * 1.15;

    const total_hours = rows
      .filter((r) => r.month === month)
      .reduce((s, r) => s + (r.total_hours ?? 0), 0);

    return {
      month,
      w2_ops, w2_rd, sub_rd_contractors, sub_3pillar, sub_testing,
      subtotal_labor,
      tax_bene_rate: rate,
      rd_labor_grossed, total_labor_sources,
      vendor_innoscale: innoscale_amt,
      vendor_powerbi: powerbi_amt,
      cip, intercompany_invoice,
      cr_rd_labor: rd_labor_grossed,
      cr_rd_subs: sub_rd_contractors,
      cr_3pillar: sub_3pillar,
      cr_testing: sub_testing,
      cr_innoscale: innoscale_amt,
      cr_powerbi: powerbi_amt,
      total_hours,
    };
  });
}

// ── YTD helper ────────────────────────────────────────────────────────────────

export function ytd<T extends { month: number }>(rows: T[], throughMonth: number): T[] {
  return rows.filter((r) => r.month <= throughMonth);
}

export function sumField<T>(rows: T[], field: keyof T): number {
  return rows.reduce((s, r) => s + ((r[field] as number) ?? 0), 0);
}
