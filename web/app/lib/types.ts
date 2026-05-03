export interface UserAccess {
  email: string;
  accessLevel: "admin" | "edit" | "view" | "none";
}

// A single BigTime time entry row from D1
export interface TimeEntry {
  id: number;
  project: string;
  staff_member: string;
  date: string;
  month: number;
  year: number;
  hours: number;
  nc_original: string | null;
  nc_mapped: string; // Chargeable | R&D | Enc R&D | OH
  notes: string | null;
  labor_rate: number | null;
  labor_cost: number | null;
  dept: string | null;
  vendor: string | null;
}

export interface RosterEntry {
  name: string;
  emp_type: string;           // W-2 | Sub
  dept: string;               // Ops | R&D | G&A | Fin
  company: string;            // Radix | 3Pillar | Testing Xperts | Contractor
  sub_category: string | null;
  default_alloc: string;      // 'BT' | '100%'
  primary_nc_bucket: string | null;
  hourly_rate: number | null;
  annual_salary: number | null;
  monthly_rate: number | null;
}

export interface RateHistoryRow {
  id: number;
  name: string;
  effective_date: string; // ISO YYYY-MM-DD
  hourly_rate: number | null;
  monthly_rate: number | null;
}

export interface MonthlyOverride {
  staff_member: string;
  year: number;
  month: number;
  nc_bucket: string;
  use_monthly_rate: number; // 0 | 1
}

export interface TaxBeneRate {
  year: number;
  month: number;
  rate: number;
}

export interface VendorInvoice {
  vendor: string;
  month: number;
  year: number;
  amount: number;
  nc_bucket: string;
}

// Aggregated monthly labor cost by employee-type category
export interface MonthlyLaborRow {
  month: number;
  year: number;
  w2_ops: number;
  w2_rd: number;
  w2_ga: number;
  sub_ops: number;
  sub_rd: number;
  sub_3pillar: number;
  sub_testing: number;
  total: number;
}

// Per-person detail row for the drill-down tables
export interface PersonDetail {
  staff_member: string;
  company: string;
  emp_type: string;
  dept: string;
  sub_category: string | null;
  month: number;
  year: number;
  hours: number;
  labor_cost: number;
}

// Journal entry line
export interface JournalLine {
  account: string;
  month: number;
  year: number;
  amount: number;   // positive = debit, negative = credit
}
