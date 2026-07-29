import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

export interface TrendDatum {
  d: string; // YYYY-MM-DD
  revenue: number;
  profit: number;
}

// US-2234: revenue + net-profit over time for the Analytics view. Lazy-loaded at
// the chart boundary so Recharts stays out of the route-entry chunk (US-408).
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
        <YAxis fontSize={11} tickLine={false} axisLine={false} unit="$" width={56} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value, name) => [`$${Number(value ?? 0).toFixed(2)}`, name]}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="revenue"
          name="Revenue"
          stroke="#0F3460"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="profit"
          name="Net profit"
          stroke="#E94560"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
