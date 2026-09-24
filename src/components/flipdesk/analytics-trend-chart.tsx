import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  CHART_TOOLTIP_STYLE,
  SERIES,
  usdExact,
  usdTick,
} from "@/lib/chart-theme";

export interface TrendDatum {
  d: string; // YYYY-MM-DD
  revenue: number;
  profit: number;
}

// US-2234: revenue + net-profit over time for the Analytics view. Lazy-loaded at
// the chart boundary so Recharts stays out of the route-entry chunk (US-408).
//
// A6: series colours from the shared theme (profit is no longer brand red, which
// read as a loss), "$25" ticks instead of "25$", and a zero line so a day in
// the red is visibly below it.
export function AnalyticsTrendChart({ data }: { data: TrendDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="d"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={(d: string) => (d ?? "").slice(5)}
        />
        <YAxis
          fontSize={11}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={usdTick}
        />
        <Tooltip
          contentStyle={CHART_TOOLTIP_STYLE}
          formatter={(value, name) => [usdExact(value), name]}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <ReferenceLine y={0} className="stroke-border" />
        <Line
          type="monotone"
          dataKey="revenue"
          name="Revenue"
          stroke={SERIES.primary}
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="profit"
          name="Net profit"
          stroke={SERIES.profit}
          strokeWidth={2}
          strokeDasharray="5 3"
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
