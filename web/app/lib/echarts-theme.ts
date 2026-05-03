export const CHART_COLORS = {
  primary:        "#A1CE5E",
  forecast:       "rgba(161, 206, 94, 0.4)",
  positive:       "#6AAA8E",
  negative:       "#C47A7A",
  warning:        "#C9A96E",
  info:           "#5B9BD5",
  gray:           "#64748B",
  barBlue:        "#4B9FD6",
  barBlueFaded:   "rgba(75, 159, 214, 0.4)",
  barBlueDark:    "#2E7FC5",
  barBlueLight:   "#7BB8E6",
  series: [
    "#A1CE5E",
    "#5B9BD5",
    "#C9A96E",
    "#8B5CF6",
    "#EC4899",
    "#14B8A6",
    "#F59E0B",
    "#6366F1",
  ],
} as const;

export const CHART_DEFAULTS = {
  textStyle: {
    fontFamily: "Source Sans 3, sans-serif",
    color: "#94A3B8",
  },
  tooltip: {
    trigger: "axis" as const,
    backgroundColor: "#1C1F21",
    borderColor: "rgba(255,255,255,0.08)",
    textStyle: {
      color: "#E8EDF2",
      fontFamily: "Source Sans 3, sans-serif",
      fontSize: 13,
    },
  },
  grid: {
    left: 60,
    right: 24,
    top: 40,
    bottom: 40,
  },
  axisLine: {
    lineStyle: { color: "rgba(255,255,255,0.08)" },
  },
  splitLine: {
    lineStyle: { color: "rgba(255,255,255,0.05)" },
  },
} as const;
