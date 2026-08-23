import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// US-2819: price against grade, with the cohort's spread drawn as a band.
//
// Own file so Recharts stays out of the route-entry chunk, the same boundary
// AnalyticsTrendChart and AnalyticsBarChart use (US-408).
//
// THE TWO SERIES COLORS ARE NOT THE RAW BRAND HEX, and that is deliberate.
// Brand navy #0F3460 fails a categorical-palette check twice over as a chart
// mark: L 0.325 sits under the readable band and its chroma 0.088 reads as gray
// next to a red. #3B72D9 is the same hue family stepped into the band; paired
// with brand red it clears CVD separation (protan dE 19.1), the normal-vision
// floor (31.6) and 3:1 contrast against BOTH the light and the dark chart
// surface, so one pair serves both themes. Navy stays the UI color; this is the
// data color.
const COHORT = "#3B72D9";
const OWN = "#E94560";

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

export interface CurveDatum {
  grade: number;
  /** [p25, p75] of the cohort, or null when the bucket is suppressed. */
  band: [number, number] | null;
  cohort: number | null;
  own: number | null;
}

function dollars(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "-";
}

export function ConditionCurveChart({ data }: { data: CurveDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="grade"
          type="number"
          domain={["dataMin", "dataMax"]}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          // Grades are the reason this chart exists; spell them out rather than
          // letting the axis pick round numbers that are not real buckets.
          ticks={data.map((d) => d.grade)}
          tickFormatter={(g: number) => g.toFixed(1)}
          label={{ value: "Grade", position: "insideBottom", offset: -4, fontSize: 11 }}
        />
        <YAxis
          fontSize={11}
          tickLine={false}
          axisLine={false}
          width={60}
          tickFormatter={(v: number) => `$${Math.round(v)}`}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(g) => `Grade ${Number(g).toFixed(1)}`}
          formatter={(value, name) => {
            if (name === "Cohort spread" && Array.isArray(value)) {
              return [`${dollars(value[0])} to ${dollars(value[1])}`, name];
            }
            return [dollars(value), name];
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {/* The band is drawn first so both lines sit on top of it. */}
        <Area
          dataKey="band"
          name="Cohort spread"
          stroke="none"
          fill={COHORT}
          fillOpacity={0.14}
          isAnimationActive={false}
          connectNulls
        />
        <Line
          dataKey="cohort"
          name="Cohort median"
          type="monotone"
          stroke={COHORT}
          strokeWidth={2}
          dot={{ r: 4, fill: COHORT, stroke: "hsl(var(--card))", strokeWidth: 2 }}
          activeDot={{ r: 6 }}
          isAnimationActive={false}
          connectNulls
        />
        <Line
          dataKey="own"
          name="Your median"
          type="monotone"
          stroke={OWN}
          strokeWidth={2}
          strokeDasharray="5 3"
          dot={{ r: 4, fill: OWN, stroke: "hsl(var(--card))", strokeWidth: 2 }}
          activeDot={{ r: 6 }}
          isAnimationActive={false}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
