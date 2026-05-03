type Variant = "green" | "red" | "amber" | "blue" | "gray" | "purple";

const styles: Record<Variant, string> = {
  green:  "bg-dash-positive-bg text-dash-positive ring-dash-positive/30",
  red:    "bg-dash-negative-bg text-dash-negative ring-dash-negative/30",
  amber:  "bg-dash-warning-bg text-dash-warning ring-dash-warning/30",
  blue:   "bg-dash-info-bg text-dash-info ring-dash-info/30",
  gray:   "bg-white/5 text-dash-text-muted ring-white/10",
  purple: "bg-purple-500/10 text-purple-400 ring-purple-500/20",
};

export default function Badge({ label, variant = "gray" }: { label: string; variant?: Variant }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-ui font-medium ring-1 ${styles[variant]}`}>
      {label}
    </span>
  );
}
