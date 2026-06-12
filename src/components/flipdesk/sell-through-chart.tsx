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

export interface SellThroughDatum {
  name: string;
  rate: number;
  sold: number;
  listed: number;
}

// Isolated so the FlipDesk Analytics route can lazy-load Recharts (~346KB) at
// the chart boundary instead of shipping it in the route-entry chunk (US-408).
export function SellThroughChart({ data }: { data: SellThroughDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, data.length * 34)}>
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
          domain={[0, 100]}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          unit="%"
        />
        <YAxis
          type="category"
          dataKey="name"
          width={120}
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value) => [`${value ?? 0}%`, "Sell-through"]}
        />
        <Bar dataKey="rate" fill="#0F3460" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
