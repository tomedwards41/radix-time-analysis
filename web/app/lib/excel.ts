import * as XLSX from "xlsx";
import type { PSMonthData } from "./computations";
import { MONTHS } from "./computations";
import { MONTH_LABELS } from "./formatters";
import type { PersonDetail } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthHeaders(year: number): string[] {
  return MONTH_LABELS.map((l) => `${l}-${String(year).slice(-2)}`);
}

function sum(vals: number[]): number {
  return vals.reduce((s, v) => s + v, 0);
}

// Number cell with accounting format
function n(v: number): XLSX.CellObject {
  return { v, t: "n", z: '#,##0.00' };
}

// Colgroup: description col + 12 month cols + YTD col
function summaryCols(): XLSX.ColInfo[] {
  return [{ wch: 30 }, ...Array(12).fill({ wch: 13 }), { wch: 14 }];
}

function numRow(label: string, vals: number[]): (string | XLSX.CellObject)[] {
  return [label, ...vals.map(n), n(sum(vals))];
}

// ── Sheet builders ────────────────────────────────────────────────────────────

function buildSummarySheet(monthly: PSMonthData[], year: number): XLSX.WorkSheet {
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
    ["PR Tax & Bene Rate", ...monthly.map((m) => `${(m.tax_bene_rate * 100).toFixed(1)}%`), ""],
    numRow("Payroll Taxes & Benes", w2TaxBene),
    numRow("Total Costs",           monthly.map((m) => m.total_cos)),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = summaryCols();
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }];
  return ws;
}

function buildJournalSheet(monthly: PSMonthData[], year: number): XLSX.WorkSheet {
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

function buildPersonSheet(
  personRows: PersonDetail[],
  year: number,
  field: "hours" | "labor_cost",
  title: string,
): XLSX.WorkSheet {
  // Pivot: company → dept → name → { empType, months }
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

    // Accumulate company totals first
    for (const dept of Object.keys(coData)) {
      for (const pdata of Object.values(coData[dept])) {
        MONTHS.forEach((m, i) => { coMonths[i] += pdata.months[m] ?? 0; });
      }
    }
    MONTHS.forEach((_, i) => { grandMonths[i] += coMonths[i]; });

    aoa.push([co, "", "", "", ...coMonths.map(fmt), fmt(sum(coMonths))]);

    for (const dept of Object.keys(coData).sort()) {
      const deptData   = coData[dept];
      const deptMonths = Array(12).fill(0) as number[];

      for (const pdata of Object.values(deptData)) {
        MONTHS.forEach((m, i) => { deptMonths[i] += pdata.months[m] ?? 0; });
      }

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

// ── Public API ────────────────────────────────────────────────────────────────

export function generatePSExcel(
  monthly: PSMonthData[],
  personRows: PersonDetail[],
  year: number,
): Uint8Array {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, buildSummarySheet(monthly, year),  "Summary");
  XLSX.utils.book_append_sheet(wb, buildJournalSheet(monthly, year),   "Journal Entry");
  XLSX.utils.book_append_sheet(wb, buildPersonSheet(personRows, year, "hours",      "Hours by Staff Member"), "Hours by Person");
  XLSX.utils.book_append_sheet(wb, buildPersonSheet(personRows, year, "labor_cost", "Cost by Staff Member"),  "Cost by Person");

  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
