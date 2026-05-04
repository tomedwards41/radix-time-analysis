import type {
  TimeEntry, RosterEntry, TaxBeneRate, VendorInvoice, PersonDetail,
  RateHistoryRow, MonthlyOverride, RdAllocation, RdFeature, EncPlatformAllocation,
} from "./types";

type Stmt = {
  all: <T>() => Promise<{ results: T[] }>;
  first: <T>() => Promise<T | null>;
  run: () => Promise<unknown>;
};

type DB = {
  prepare: (sql: string) => Stmt & {
    bind: (...args: unknown[]) => Stmt;
  };
};

export async function getRoster(db: DB): Promise<RosterEntry[]> {
  const { results } = await db
    .prepare("SELECT * FROM roster ORDER BY company, name")
    .all<RosterEntry>();
  return results;
}

export async function getTaxBeneRates(db: DB, year: number): Promise<TaxBeneRate[]> {
  const { results } = await db
    .prepare("SELECT * FROM tax_bene_rates WHERE year = ? ORDER BY month")
    .bind(year)
    .all<TaxBeneRate>();
  return results;
}

export async function getVendorInvoices(db: DB, year: number): Promise<VendorInvoice[]> {
  const { results } = await db
    .prepare("SELECT * FROM vendor_invoices WHERE year = ? ORDER BY nc_bucket, vendor, month")
    .bind(year)
    .all<VendorInvoice>();
  return results;
}

// Monthly labor cost aggregates for a given NC bucket and year
// Returns one row per (month, sub_category) combination
export async function getMonthlyLaborByCategory(
  db: DB,
  ncBucket: string,
  year: number
): Promise<{ month: number; sub_category: string; total_cost: number; total_hours: number }[]> {
  const { results } = await db
    .prepare(`
      SELECT
        te.month,
        COALESCE(r.sub_category, 'Unknown') AS sub_category,
        SUM(te.labor_cost)  AS total_cost,
        SUM(te.hours)       AS total_hours
      FROM time_entries te
      LEFT JOIN roster r ON r.name = te.staff_member
      WHERE te.nc_mapped = ? AND te.year = ?
      GROUP BY te.month, r.sub_category
      ORDER BY te.month, r.sub_category
    `)
    .bind(ncBucket, year)
    .all<{ month: number; sub_category: string; total_cost: number; total_hours: number }>();
  return results;
}

// Per-person monthly detail for a given NC bucket
export async function getPersonDetail(
  db: DB,
  ncBucket: string,
  year: number
): Promise<PersonDetail[]> {
  const { results } = await db
    .prepare(`
      SELECT
        te.staff_member,
        COALESCE(r.company,      'Unknown') AS company,
        COALESCE(r.emp_type,     'Unknown') AS emp_type,
        COALESCE(r.dept,         'Unknown') AS dept,
        r.sub_category,
        te.month,
        te.year,
        SUM(te.hours)      AS hours,
        SUM(te.labor_cost) AS labor_cost
      FROM time_entries te
      LEFT JOIN roster r ON r.name = te.staff_member
      WHERE te.nc_mapped = ? AND te.year = ?
      GROUP BY te.staff_member, te.month, te.year
      ORDER BY r.company, te.staff_member, te.month
    `)
    .bind(ncBucket, year)
    .all<PersonDetail>();
  return results;
}

// Available years with data
export async function getAvailableYears(db: DB): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT year FROM time_entries ORDER BY year DESC")
    .all<{ year: number }>();
  return results.map((r) => r.year);
}

export async function getRateHistory(db: DB): Promise<RateHistoryRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM roster_rate_history ORDER BY name, effective_date")
    .all<RateHistoryRow>();
  return results;
}

export async function getAllMonthlyOverridesForYear(db: DB, year: number): Promise<MonthlyOverride[]> {
  const { results } = await db
    .prepare("SELECT * FROM monthly_overrides WHERE year = ?")
    .bind(year)
    .all<MonthlyOverride>();
  return results;
}

export async function getMonthlyOverrides(db: DB, year: number, month: number): Promise<MonthlyOverride[]> {
  const { results } = await db
    .prepare("SELECT * FROM monthly_overrides WHERE year = ? AND month = ?")
    .bind(year, month)
    .all<MonthlyOverride>();
  return results;
}

// Returns 100% people whose primary_nc_bucket = 'Enc R&D', for the override panel
export async function getEncRDOverridePeople(
  db: DB
): Promise<{ staff_member: string; company: string; sub_category: string | null; default_alloc: string }[]> {
  const { results } = await db
    .prepare(`
      SELECT name AS staff_member, company, sub_category, default_alloc
      FROM roster
      WHERE primary_nc_bucket = 'Enc R&D' AND default_alloc = '100%'
      ORDER BY company, name
    `)
    .all<{ staff_member: string; company: string; sub_category: string | null; default_alloc: string }>();
  return results;
}

export async function saveMonthlyOverrides(
  db: DB,
  year: number,
  month: number,
  overrides: { staff_member: string; nc_bucket: string; use_monthly_rate: number }[]
): Promise<void> {
  await db
    .prepare("DELETE FROM monthly_overrides WHERE year = ? AND month = ?")
    .bind(year, month)
    .run();
  for (const o of overrides) {
    await db
      .prepare(
        "INSERT INTO monthly_overrides (staff_member, year, month, nc_bucket, use_monthly_rate) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(o.staff_member, year, month, o.nc_bucket, o.use_monthly_rate)
      .run();
  }
}

// ── Roster admin ─────────────────────────────────────────────────────────────

export interface RosterWithRate extends RosterEntry {
  current_hourly_rate: number | null;
  rate_as_of: string | null;
}

export async function getRosterWithCurrentRates(db: DB): Promise<RosterWithRate[]> {
  const { results } = await db
    .prepare(`
      SELECT r.*,
        COALESCE(
          (SELECT hourly_rate FROM roster_rate_history WHERE name = r.name ORDER BY effective_date DESC LIMIT 1),
          r.hourly_rate
        ) AS current_hourly_rate,
        (SELECT effective_date FROM roster_rate_history WHERE name = r.name ORDER BY effective_date DESC LIMIT 1) AS rate_as_of
      FROM roster r
      ORDER BY r.company, r.name
    `)
    .all<RosterWithRate>();
  return results;
}

export async function getRateHistoryForPerson(db: DB, name: string): Promise<RateHistoryRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM roster_rate_history WHERE name = ? ORDER BY effective_date DESC")
    .bind(name)
    .all<RateHistoryRow>();
  return results;
}

export async function upsertRosterPerson(db: DB, p: {
  name: string; emp_type: string; dept: string; company: string;
  sub_category: string | null; default_alloc: string; primary_nc_bucket: string | null;
  hourly_rate: number | null;
}): Promise<void> {
  await db
    .prepare(`
      INSERT INTO roster (name, emp_type, dept, company, sub_category, default_alloc, primary_nc_bucket, hourly_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        emp_type = excluded.emp_type, dept = excluded.dept, company = excluded.company,
        sub_category = excluded.sub_category, default_alloc = excluded.default_alloc,
        primary_nc_bucket = excluded.primary_nc_bucket, hourly_rate = excluded.hourly_rate,
        updated_at = datetime('now')
    `)
    .bind(p.name, p.emp_type, p.dept, p.company, p.sub_category,
          p.default_alloc, p.primary_nc_bucket, p.hourly_rate)
    .run();
}

export async function addRateHistoryEntry(
  db: DB, name: string, effectiveDate: string, hourlyRate: number
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO roster_rate_history (name, effective_date, hourly_rate)
      VALUES (?, ?, ?)
      ON CONFLICT(name, effective_date) DO UPDATE SET hourly_rate = excluded.hourly_rate
    `)
    .bind(name, effectiveDate, hourlyRate)
    .run();
}

// ── Interco R&D Invoice ───────────────────────────────────────────────────────

export async function getRdAllocations(db: DB): Promise<RdAllocation[]> {
  const { results } = await db
    .prepare("SELECT * FROM person_rd_allocations ORDER BY name")
    .all<RdAllocation>();
  return results;
}

export async function upsertRdAllocation(db: DB, alloc: RdAllocation): Promise<void> {
  await db
    .prepare(`
      INSERT INTO person_rd_allocations (name, enc_platforms, data_platforms, reporting_bi, maintenance)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        enc_platforms  = excluded.enc_platforms,
        data_platforms = excluded.data_platforms,
        reporting_bi   = excluded.reporting_bi,
        maintenance    = excluded.maintenance
    `)
    .bind(alloc.name, alloc.enc_platforms, alloc.data_platforms, alloc.reporting_bi, alloc.maintenance)
    .run();
}

export async function getRdFeatures(db: DB): Promise<RdFeature[]> {
  const { results } = await db
    .prepare("SELECT * FROM rd_features ORDER BY bucket, sort_order")
    .all<RdFeature>();
  return results;
}

export async function getEncPlatformAllocations(db: DB, year: number): Promise<EncPlatformAllocation[]> {
  const { results } = await db
    .prepare("SELECT * FROM enc_platform_allocations WHERE year = ? ORDER BY month, feature_id")
    .bind(year)
    .all<EncPlatformAllocation>();
  return results;
}

export async function upsertEncPlatformAllocation(
  db: DB, featureId: number, year: number, month: number, pct: number
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO enc_platform_allocations (feature_id, year, month, allocation_pct)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(feature_id, year, month) DO UPDATE SET allocation_pct = excluded.allocation_pct
    `)
    .bind(featureId, year, month, pct)
    .run();
}

// Row count per NC bucket for the upload page summary
export async function getImportSummary(db: DB): Promise<{ nc_mapped: string; year: number; month: number; row_count: number; total_hours: number; total_cost: number }[]> {
  const { results } = await db
    .prepare(`
      SELECT nc_mapped, year, month,
             COUNT(*) AS row_count,
             SUM(hours) AS total_hours,
             SUM(labor_cost) AS total_cost
      FROM time_entries
      GROUP BY nc_mapped, year, month
      ORDER BY year DESC, month DESC, nc_mapped
    `)
    .all<{ nc_mapped: string; year: number; month: number; row_count: number; total_hours: number; total_cost: number }>();
  return results;
}
