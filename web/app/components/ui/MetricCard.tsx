interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  delta?: string;
  deltaDirection?: "up" | "down" | "neutral";
  valueColor?: string;
}

export default function MetricCard({
  title,
  value,
  subtitle,
  delta,
  deltaDirection,
  valueColor = "text-dash-text",
}: MetricCardProps) {
  const deltaColor =
    deltaDirection === "up"
      ? "text-dash-positive"
      : deltaDirection === "down"
        ? "text-dash-negative"
        : "text-dash-text-muted";

  return (
    <div className="bg-dash-surface rounded-lg border border-dash-border p-3.5 flex flex-col gap-1 min-w-[140px] flex-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-white/20 cursor-default">
      <p className="text-[10px] font-ui font-medium text-dash-text-secondary uppercase tracking-[0.12em]">
        {title}
      </p>
      <div className="flex items-baseline gap-2">
        <p className={`text-[22px] font-heading font-semibold ${valueColor}`}>{value}</p>
        {delta && (
          <span className={`text-[10px] font-ui font-medium ${deltaColor}`}>{delta}</span>
        )}
      </div>
      {subtitle && <p className="text-xs text-dash-text-muted">{subtitle}</p>}
    </div>
  );
}
