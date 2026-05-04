import * as XLSX from "xlsx";
import type { PSMonthData, RadixRDMonthData, EncRDMonthData, BucketMonthData, FeatureMonthData } from "./computations";
import { MONTHS } from "./computations";
import { MONTH_LABELS } from "./formatters";
import type { PersonDetail, RdFeature } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthHeaders(year: number): string[] {
  return MONTH_LABELS.map((l) => `${l}-${String(year).slice(-2)}`);
}

function sum(vals: number[]): number {
  return vals.reduce((s, v) => s + v, 0);
}

function n(v: number): XLSX.CellObject {
  return { v, t: "n", z: '#,##0.00' };
}

function summaryCols(): XLSX.ColInfo[] {
  return [{ wch: 34 }, ...Array(12).fill({ wch: 13 }), { wch: 14 }];
}

function numRow(label: string, vals: number[]): (string | XLSX.CellObject)[] {
  return [label, ...vals.map(n), n(sum(vals))];
}

function pctRow(label: string, vals: number[]): (string | XLSX.CellObject)[] {
  return [label, ...vals.map((v) => `${(v * 100).toFixed(1)}%`), ""];
}

// ── Shared: person detail sheets ──────────────────────────────────────────────

function buildPersonSheet(
  personRows: PersonDetail[],
  year: number,
  field: "hours" | "labor_cost",
  title: string,
): XLSX.WorkSheet {
  type PersonBucket = { empType: string; months: Record<number, number> };
  const grouped: Record<string, Record<string, Record<string, PersonBucket>>> = {};

  for (const r of personRows) {
    const co   = r.company      ?? "Unknown";
    const dept = r.dept         ?? "Unknown";
    const name = r.staff_member;
    grouped[co]            ??= {};
    grouped[co][dept]      ??= {};
    grouped[co][dept][name] ??= { empType: r.emp_type ?? "", months: {} };
    const bkt = grouped[co][dept][name];
    bkt.months[r.month] = (bkt.months[r.month] ?? 0) + ((field === "hours" ? r.hours : r.labor_cost) ?? 0);
  }

  const coOrder = ["Radix", ...Object.keys(grouped).filter((c) => c !== "Radix").sort()];
  const hdrs    = monthHeaders(year);
  const totalLabel = field === "hours" ? "Total Hours" : "Total Cost";
  const fmt = field === "hours" ? (v: number): XLSX.CellObject => ({ v, t: "n", z: "#,##0.0" }) : n;

  const aoa: (string | XLSX.CellObject)[][] = [
    [`${title} — ${year}`],
    [],
    ["Company", "Dept", "Name", "Emp Type", ...hdrs, totalLabel],
  ];

  const grandMonths = Array(12).fill(0) as number[];

  for (const co of coOrder.filter((c) => grouped[c])) {
    const coData   = grouped[co];
    const coMonths = Array(12).fill(0) as number[];
    for (const dept of Object.keys(coData))
      for (const pdata of Object.values(coData[dept]))
        MONTHS.forEach((m, i) => { coMonths[i] += pdata.months[m] ?? 0; });
    MONTHS.forEach((_, i) => { grandMonths[i] += coMonths[i]; });
    aoa.push([co, "", "", "", ...coMonths.map(fmt), fmt(sum(coMonths))]);

    for (const dept of Object.keys(coData).sort()) {
      const deptData   = coData[dept];
      const deptMonths = Array(12).fill(0) as number[];
      for (const pdata of Object.values(deptData))
        MONTHS.forEach((m, i) => { deptMonths[i] += pdata.months[m] ?? 0; });
      aoa.push(["", dept, "", "", ...deptMonths.map(fmt), fmt(sum(deptMonths))]);

      for (const name of Object.keys(deptData).sort()) {
        const pdata   = deptData[name];
        const pMonths = MONTHS.map((m) => pdata.months[m] ?? 0);
        aoa.push(["", "", name, pdata.empType, ...pMonths.map(fmt), fmt(sum(pMonths))]);
      }
    }
  }

  aoa.push(["Grand Total", "", "", "", ...grandMonths.map(fmt), fmt(sum(grandMonths))]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 15 }, { wch: 12 }, { wch: 30 }, { wch: 10 },
    ...Array(12).fill({ wch: 12 }),
    { wch: 14 },
  ];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 16 } }];
  return ws;
}

// ── PS sheet builders ─────────────────────────────────────────────────────────

function buildPSSummarySheet(monthly: PSMonthData[], year: number): XLSX.WorkSheet {
  const hdrs = monthHeaders(year);
  const w2TaxBene = monthly.map((m) => (m.w2_ops + m.w2_rd + m.w2_ga) * m.tax_bene_rate);

  const aoa: (string | XLSX.CellObject)[][] = [
    [`Radix Professional Services — Cost of Sales — ${year}`],
    [],
    ["", ...hdrs, "YTD"],
    numRow("W-2 — Ops",             monthly.map((m) => m.w2_ops)),
    numRow("W-2 — R&D",             monthly.map((m) => m.w2_rd)),
    numRow("W-2 — G&A",             monthly.map((m) => m.w2_ga)),
    numRow("Sub — Ops",             monthly.map((m) => m.sub_ops)),
    numRow("Sub — R&D",             monthly.map((m) => m.sub_rd)),
    numRow("Subtotal Labor",        monthly.map((m) => m.subtotal_labor)),
    [],
    pctRow("PR Tax & Bene Rate",    monthly.map((m) => m.tax_bene_rate)),
    numRow("Payroll Taxes & Benes", w2TaxBene),
    numRow("Total Costs",           monthly.map((m) => m.total_cos)),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

function buildPSJournalSheet(monthly: PSMonthData[], year: number): XLSX.WorkSheet {
  const hdrs = monthHeaders(year);
  const net  = monthly.map((m) =>
    m.total_cos - m.cr_ops_comp - m.cr_rd_comp - m.cr_ga_comp - m.cr_ops_subs - m.cr_rd_subs
  );

  const aoa: (string | XLSX.CellObject)[][] = [
    [`Journal Entry — Professional Services — ${year}`],
    [],
    ["", ...hdrs, "YTD"],
    numRow("Cost of Labor — COS (Dr)",     monthly.map((m) =>  m.cos_labor)),
    numRow("Subcontractors — COS (Dr)",    monthly.map((m) =>  m.cos_subs)),
    numRow("  Ops Compensation (Cr)",      monthly.map((m) => -m.cr_ops_comp)),
    numRow("  R&D Compensation (Cr)",      monthly.map((m) => -m.cr_rd_comp)),
    numRow("  G&A Compensation (Cr)",      monthly.map((m) => -m.cr_ga_comp)),
    numRow("  Ops Subcontractors (Cr)",    monthly.map((m) => -m.cr_ops_subs)),
    numRow("  R&D Subcontractors (Cr)",    monthly.map((m) => -m.cr_rd_subs)),
    [],
    numRow("Net (check — should be $0)",   net),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

// ── Radix R&D sheet builders ──────────────────────────────────────────────────

function buildRadixRDSummarySheet(monthly: RadixRDMonthData[], year: number): XLSX.WorkSheet {
  const hdrs = monthHeaders(year);
  const w2TaxBene = monthly.map((m) => m.w2_rd * m.tax_bene_rate);

  const aoa: (string | XLSX.CellObject)[][] = [
    [`Radix R&D — Construction in Process — ${year}`],
    [],
    ["", ...hdrs, "YTD"],
    numRow("W-2 — R&D",              monthly.map((m) => m.w2_rd)),
    numRow("Sub — R&D",              monthly.map((m) => m.sub_rd)),
    numRow("Sub — 3Pillar",          monthly.map((m) => m.sub_3pillar)),
    numRow("Subtotal Labor",         monthly.map((m) => m.subtotal_labor)),
    [],
    pctRow("PR Tax & Bene Rate",     monthly.map((m) => m.tax_bene_rate)),
    numRow("Payroll Taxes & Benes",  w2TaxBene),
    numRow("Total Labor (CIP)",      monthly.map((m) => m.cip)),
    [],
    ["Vendor Invoices"],
    numRow("Innoscale",              monthly.map((m) => m.vendor_innoscale)),
    numRow("Power BI",               monthly.map((m) => m.vendor_powerbi)),
    numRow("Subtotal Vendors",       monthly.map((m) => m.vendor_innoscale + m.vendor_powerbi)),
    [],
    numRow("Total CIP",              monthly.map((m) => m.total_cip)),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

function buildRadixRDJournalSheet(monthly: RadixRDMonthData[], year: number): XLSX.WorkSheet {
  const hdrs = monthHeaders(year);
  const net = monthly.map((m) =>
    m.total_cip - m.cr_rd_comp - m.cr_rd_subs - m.cr_3pillar - m.cr_innoscale - m.cr_powerbi
  );

  const aoa: (string | XLSX.CellObject)[][] = [
    [`Journal Entry — Radix R&D — ${year}`],
    [],
    ["", ...hdrs, "YTD"],
    numRow("Construction in Process (Dr)",    monthly.map((m) =>  m.total_cip)),
    numRow("  R&D Compensation (Cr)",         monthly.map((m) => -m.cr_rd_comp)),
    numRow("  R&D Subcontractors (Cr)",       monthly.map((m) => -m.cr_rd_subs)),
    numRow("  R&D Subs — 3Pillar (Cr)",       monthly.map((m) => -m.cr_3pillar)),
    numRow("  R&D Subs — Innoscale (Cr)",     monthly.map((m) => -m.cr_innoscale)),
    numRow("  G&A Software — BI Reports (Cr)",monthly.map((m) => -m.cr_powerbi)),
    [],
    numRow("Net (check — should be $0)",      net),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

// ── enCompass R&D sheet builders ──────────────────────────────────────────────

function buildEncRDSummarySheet(monthly: EncRDMonthData[], year: number): XLSX.WorkSheet {
  const hdrs = monthHeaders(year);
  const w2TaxBene = monthly.map((m) => (m.w2_ops + m.w2_rd) * m.tax_bene_rate);

  const aoa: (string | XLSX.CellObject)[][] = [
    [`enCompass R&D — Construction in Process — ${year}`],
    [],
    ["", ...hdrs, "YTD"],
    numRow("W-2 — Ops",               monthly.map((m) => m.w2_ops)),
    numRow("W-2 — R&D",               monthly.map((m) => m.w2_rd)),
    numRow("Sub — R&D",               monthly.map((m) => m.sub_rd_contractors)),
    numRow("Sub — 3Pillar",           monthly.map((m) => m.sub_3pillar)),
    numRow("Sub — Testing",           monthly.map((m) => m.sub_testing)),
    numRow("Subtotal Labor",          monthly.map((m) => m.subtotal_labor)),
    [],
    pctRow("PR Tax & Bene Rate",      monthly.map((m) => m.tax_bene_rate)),
    numRow("Payroll Taxes & Benes",   w2TaxBene),
    numRow("Total Labor (CIP labor)", monthly.map((m) => m.total_labor_sources)),
    [],
    ["Vendor Invoices"],
    numRow("Innoscale",               monthly.map((m) => m.vendor_innoscale)),
    numRow("Power BI",                monthly.map((m) => m.vendor_powerbi)),
    numRow("Subtotal Vendors",        monthly.map((m) => m.vendor_innoscale + m.vendor_powerbi)),
    [],
    numRow("CIP Total",               monthly.map((m) => m.cip)),
    numRow("Interco Invoice (×1.15)", monthly.map((m) => m.intercompany_invoice)),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

function buildEncRDJournalSheet(monthly: EncRDMonthData[], year: number): XLSX.WorkSheet {
  const hdrs = monthHeaders(year);
  const net = monthly.map((m) =>
    m.cip - m.cr_rd_labor - m.cr_rd_subs - m.cr_3pillar - m.cr_testing - m.cr_innoscale - m.cr_powerbi
  );

  const aoa: (string | XLSX.CellObject)[][] = [
    [`Journal Entry — enCompass R&D — ${year}`],
    [],
    ["", ...hdrs, "YTD"],
    numRow("Construction in Process (Dr)",      monthly.map((m) =>  m.cip)),
    numRow("  R&D Labor incl. T&B (Cr)",        monthly.map((m) => -m.cr_rd_labor)),
    numRow("  R&D Subs — Contractors (Cr)",     monthly.map((m) => -m.cr_rd_subs)),
    numRow("  R&D Subs — 3Pillar (Cr)",         monthly.map((m) => -m.cr_3pillar)),
    numRow("  R&D Subs — Testing Xperts (Cr)",  monthly.map((m) => -m.cr_testing)),
    numRow("  R&D Subs — Innoscale (Cr)",       monthly.map((m) => -m.cr_innoscale)),
    numRow("  R&D Software — BI Reports (Cr)",  monthly.map((m) => -m.cr_powerbi)),
    [],
    numRow("Net (check — should be $0)",        net),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

function buildEncRDIntercoSheet(monthly: EncRDMonthData[], year: number): XLSX.WorkSheet {
  const hdrs = monthHeaders(year);

  const aoa: (string | XLSX.CellObject)[][] = [
    [`Intercompany Invoice — enCompass R&D — ${year}`],
    [],
    ["", ...hdrs, "YTD"],
    numRow("CIP",                    monthly.map((m) => m.cip)),
    numRow("Billing Amt (CIP ×1.15)", monthly.map((m) => m.intercompany_invoice)),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

// ── Interco R&D sheet builders ────────────────────────────────────────────────

function buildIntercoStep1Sheet(step1: BucketMonthData[], year: number): XLSX.WorkSheet {
  const hdrs = monthHeaders(year);
  const row  = (label: string, key: keyof BucketMonthData) =>
    numRow(label, MONTHS.map((m) => (step1.find((r) => r.month === m)?.[key] as number) ?? 0));

  const aoa: (string | XLSX.CellObject)[][] = [
    [`Interco R&D Invoice — Step 1 (incl. 15% markup) — ${year}`],
    [],
    ["Category", ...hdrs, "YTD"],
    row("enCompass Platforms",  "enc_platforms"),
    row("Data Platforms",       "data_platforms"),
    row("Reporting / BI",       "reporting_bi"),
    row("Maintenance",          "maintenance"),
    row("Total",                "total"),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

function buildIntercoStep2Sheet(
  step1: BucketMonthData[],
  step2: FeatureMonthData[],
  features: RdFeature[],
  bucket: string,
  bucketLabel: string,
  bucketKey: keyof BucketMonthData,
  year: number,
): XLSX.WorkSheet {
  const hdrs = monthHeaders(year);
  const bucketFeatures = features.filter((f) => f.bucket === bucket);

  const step2Val = (fid: number, month: number) =>
    step2.find((r) => r.feature_id === fid && r.month === month)?.amount ?? 0;

  const featureRows = bucketFeatures.map((f) =>
    numRow(f.name, MONTHS.map((m) => step2Val(f.id, m)))
  );

  const totalRow = numRow(
    `Total ${bucketLabel}`,
    MONTHS.map((m) => (step1.find((r) => r.month === m)?.[bucketKey] as number) ?? 0),
  );

  const aoa: (string | XLSX.CellObject)[][] = [
    [`Interco R&D Invoice — Step 2: ${bucketLabel} — ${year}`],
    [],
    ["Feature", ...hdrs, "YTD"],
    ...featureRows,
    totalRow,
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function generatePSExcel(
  monthly: PSMonthData[],
  personRows: PersonDetail[],
  year: number,
): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildPSSummarySheet(monthly, year),  "Summary");
  XLSX.utils.book_append_sheet(wb, buildPSJournalSheet(monthly, year),   "Journal Entry");
  XLSX.utils.book_append_sheet(wb, buildPersonSheet(personRows, year, "hours",      "Hours by Staff Member"), "Hours by Person");
  XLSX.utils.book_append_sheet(wb, buildPersonSheet(personRows, year, "labor_cost", "Cost by Staff Member"),  "Cost by Person");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export function generateRadixRDExcel(
  monthly: RadixRDMonthData[],
  personRows: PersonDetail[],
  year: number,
): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildRadixRDSummarySheet(monthly, year), "Summary");
  XLSX.utils.book_append_sheet(wb, buildRadixRDJournalSheet(monthly, year), "Journal Entry");
  XLSX.utils.book_append_sheet(wb, buildPersonSheet(personRows, year, "hours",      "Hours by Staff Member"), "Hours by Person");
  XLSX.utils.book_append_sheet(wb, buildPersonSheet(personRows, year, "labor_cost", "Cost by Staff Member"),  "Cost by Person");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export function generateEncRDExcel(
  monthly: EncRDMonthData[],
  personRows: PersonDetail[],
  year: number,
): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildEncRDSummarySheet(monthly, year),  "Summary");
  XLSX.utils.book_append_sheet(wb, buildEncRDJournalSheet(monthly, year),   "Journal Entry");
  XLSX.utils.book_append_sheet(wb, buildEncRDIntercoSheet(monthly, year),   "Interco Invoice");
  XLSX.utils.book_append_sheet(wb, buildPersonSheet(personRows, year, "hours",      "Hours by Staff Member"), "Hours by Person");
  XLSX.utils.book_append_sheet(wb, buildPersonSheet(personRows, year, "labor_cost", "Cost by Staff Member"),  "Cost by Person");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export function generateIntercoRDExcel(
  step1: BucketMonthData[],
  step2: FeatureMonthData[],
  features: RdFeature[],
  year: number,
): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildIntercoStep1Sheet(step1, year), "Step 1");
  XLSX.utils.book_append_sheet(wb,
    buildIntercoStep2Sheet(step1, step2, features, "enc_platforms",  "Enc Platforms",  "enc_platforms",  year), "Enc Platforms");
  XLSX.utils.book_append_sheet(wb,
    buildIntercoStep2Sheet(step1, step2, features, "data_platforms", "Data Platforms", "data_platforms", year), "Data Platforms");
  XLSX.utils.book_append_sheet(wb,
    buildIntercoStep2Sheet(step1, step2, features, "reporting_bi",   "Reporting-BI",   "reporting_bi",   year), "Reporting-BI");
  XLSX.utils.book_append_sheet(wb,
    buildIntercoStep2Sheet(step1, step2, features, "maintenance",    "Maintenance",    "maintenance",    year), "Maintenance");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
