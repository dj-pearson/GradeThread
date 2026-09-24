import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CHART_TOOLTIP_STYLE, SERIES } from "@/lib/chart-theme";

export interface AnalyticsBarDatum {
  name: string;
  value: number;
}

type DomainEnd = number | "auto" | ((v: number) => number);

// A6: the axis always reaches zero, so a lift of $3 and a lift of $30 are not
// drawn as bars of similar length from an "auto" floor at $2.
const ZERO_BASED: [DomainEnd, DomainEnd] = [
  (min: number) => Math.min(0, min),
  (max: number) => Math.max(0, max),
];

// US-2234: a generic horizontal bar chart for the Analytics tabs (returns,
// grading-ROI), kept in its own module so the route lazy-loads Recharts (~346KB)
// at the chart boundary — same pattern as SellThroughChart (US-408).
//
// A6: `formatter` replaces the old `unit` suffix, which rendered dollars as
// "25$". It drives both the ticks and the tooltip. Bars below zero take the
// negative colour so a loss is never drawn in the same colour as a gain.
export function AnalyticsBarChart({
  data,
  formatter = (v) => String(v),
  color = SERIES.primary,
  label,
  domain = ZERO_BASED,
}: {
  data: AnalyticsBarDatum[];
  formatter?: (value: number) => string;
  color?: string;
  label: string;
  domain?: [DomainEnd, DomainEnd];
}) {
  const anyNegative = data.some((d) => d.value < 0);
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 34)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 5, right: 16, bottom: 5, left: 10 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          className="stroke-muted"
          horizontal={false}
        />
        <XAxis
          type="number"
          domain={domain}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => formatter(v)}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={140}
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={CHART_TOOLTIP_STYLE}
          formatter={(value) => [formatter(Number(value ?? 0)), label]}
        />
        {anyNegative && <ReferenceLine x={0} className="stroke-border" />}
        <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.value < 0 ? SERIES.negative : color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
