import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

export interface AnalyticsBarDatum {
  name: string;
  value: number;
}

// US-2234: a generic horizontal bar chart for the Analytics tabs (returns,
// grading-ROI), kept in its own module so the route lazy-loads Recharts (~346KB)
// at the chart boundary — same pattern as SellThroughChart (US-408).
export function AnalyticsBarChart({
  data,
  unit,
  color = "#0F3460",
  label,
  domain = ["auto", "auto"],
}: {
  data: AnalyticsBarDatum[];
  unit?: string;
  color?: string;
  label: string;
  domain?: [number | "auto", number | "auto"];
}) {
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
          unit={unit}
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
          contentStyle={TOOLTIP_STYLE}
          formatter={(value) => [`${value ?? 0}${unit ?? ""}`, label]}
        />
        <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
