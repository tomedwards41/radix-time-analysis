export function formatCurrency(val: number | null | undefined): string {
  if (val == null) return "—";
  const abs = Math.abs(val);
  const sign = val < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatCurrencyFull(val: number | null | undefined): string {
  if (val == null) return "—";
  const abs = Math.abs(val);
  const sign = val < 0 ? "(" : "";
  const close = val < 0 ? ")" : "";
  return `${sign}$${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(abs)}${close}`;
}

export function formatCurrencyAccounting(val: number | null | undefined): string {
  if (val == null) return "—";
  if (val === 0) return " $—   ";
  const abs = Math.abs(val);
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(abs);
  return val < 0 ? `($${formatted})` : ` $${formatted} `;
}

export function formatPercent(val: number | null | undefined): string {
  if (val == null) return "—";
  return `${(val * 100).toFixed(1)}%`;
}

export function formatNumber(val: number | null | undefined): string {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-US").format(val);
}

export function formatHours(val: number | null | undefined): string {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(val);
}

export const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatMonthLabel(month: number, year: number): string {
  return `${MONTH_LABELS[month - 1]}-${String(year).slice(-2)}`;
}
