import { lazy, Suspense } from "react";
import type { EChartsOption } from "echarts";

const Skeleton = () => <div className="h-64 bg-dash-surface/50 animate-pulse rounded-lg" />;

const LazyReactECharts = lazy(() => import("echarts-for-react"));

interface ChartWrapperProps {
  option: EChartsOption;
  height?: number | string;
  className?: string;
  noWrapper?: boolean;
}

export default function ChartWrapper({ option, height = 300, className = "", noWrapper = false }: ChartWrapperProps) {
  const brandOption: EChartsOption = {
    ...option,
    backgroundColor: "transparent",
    textStyle: {
      fontFamily: "Source Sans 3, sans-serif",
      color: "#94A3B8",
      ...option.textStyle,
    },
    grid: {
      left: 60,
      right: 24,
      top: 40,
      bottom: 40,
      containLabel: false,
      ...(option.grid && !Array.isArray(option.grid) ? option.grid : {}),
    },
  };

  if (noWrapper) {
    return (
      <Suspense fallback={<Skeleton />}>
        <LazyReactECharts option={brandOption} style={{ height, width: "100%" }} opts={{ renderer: "svg" }} />
      </Suspense>
    );
  }

  return (
    <div className={`bg-dash-surface rounded-lg border border-dash-border p-3 ${className}`}>
      <Suspense fallback={<Skeleton />}>
        <LazyReactECharts option={brandOption} style={{ height }} opts={{ renderer: "svg" }} />
      </Suspense>
    </div>
  );
}
