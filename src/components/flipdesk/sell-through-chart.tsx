import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  LabelList,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CHART_TOOLTIP_STYLE, SERIES, pctTick } from "@/lib/chart-theme";
import { sellThroughTooltip, type SellThroughDatum } from "@/lib/flipdesk-analytics";

export type { SellThroughDatum };

// A7: the rate the RPC computes is sold-in-range over listed-in-range, and an
// item listed BEFORE the range but sold inside it counts as sold. So a group can
// run past 100%, and a group with sales but no in-range listings has no rate at
// all. Neither may be drawn as an ordinary bar: the axis stops at 100 and a bar
// past it is labelled with its real value, and a null rate draws nothing rather
// than a 0% bar.

// Isolated so the FlipDesk Analytics route can lazy-load Recharts (~346KB) at
// the chart boundary instead of shipping it in the route-entry chunk (US-408).
export function SellThroughChart({ data }: { data: SellThroughDatum[] }) {
  // The bar is drawn from a copy capped at 100, and the label reads the real
  // rate. Plotting the raw rate past a clipped axis put the bar's end, and
  // so the insideRight label, past the plot edge, where it was never visible.
  const plotted = data.map((d) => ({
    ...d,
    bar: d.rate == null ? null : Math.min(d.rate, 100),
  }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, data.length * 34)}>
      <BarChart
        data={plotted}
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
          tickFormatter={pctTick}
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
          contentStyle={CHART_TOOLTIP_STYLE}
          formatter={(_value, _name, item) => [
            sellThroughTooltip(item.payload as SellThroughDatum),
            "Sell-through",
          ]}
        />
        <Bar dataKey="bar" fill={SERIES.primary} radius={[0, 4, 4, 0]}>
          <LabelList
            dataKey="rate"
            position="insideRight"
            fill="#ffffff"
            fontSize={11}
            formatter={(v: unknown) =>
              typeof v === "number" && v > 100 ? `${v}%*` : ""
            }
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
