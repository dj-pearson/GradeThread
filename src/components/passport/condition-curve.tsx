import { Link } from "react-router";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ExternalLink,
  Minus,
  TrendingDown,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// US-1282: Garment Passport condition-over-time curve. Renders the grade history
// across re-grades — each finalized grade is a point with its overall score and
// the per-factor delta from the prior grade — so a buyer can see how the garment
// has held up ("a Carfax for clothing"). The shape mirrors the PII-free
// `grade_curve` returned by the public passport endpoint (services/edge-functions
// /src/routes/passport.ts → lib/passport-curve.ts); this component only renders.

export type ConditionFactorKey =
  | "fabric_condition_score"
  | "structural_integrity_score"
  | "cosmetic_appearance_score"
  | "functional_elements_score"
  | "odor_cleanliness_score";

export interface ConditionCurvePoint {
  certificate: string | null;
  graded_at: string;
  overall: number | null;
  grade_tier: string | null;
  confidence_label: string | null;
  factors: Record<ConditionFactorKey, number | null>;
  overall_delta: number | null;
  factor_deltas: Record<ConditionFactorKey, number | null>;
}

// Factor order + labels mirror lib/passport-curve.ts CONDITION_FACTORS.
const FACTORS: { key: ConditionFactorKey; label: string }[] = [
  { key: "fabric_condition_score", label: "Fabric" },
  { key: "structural_integrity_score", label: "Structural" },
  { key: "cosmetic_appearance_score", label: "Cosmetic" },
  { key: "functional_elements_score", label: "Functional" },
  { key: "odor_cleanliness_score", label: "Odor & Clean" },
];

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/** A signed delta chip — up (green) / down (red) / no change (muted). */
function DeltaChip({ value, label }: { value: number | null; label: string }) {
  if (value === null) {
    return (
      <span className="inline-flex items-center gap-0.5 text-muted-foreground/60">
        <span className="font-medium">{label}</span>
        <Minus className="h-3 w-3" />
      </span>
    );
  }
  const up = value > 0;
  const down = value < 0;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : ArrowRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5",
        up && "text-emerald-600 dark:text-emerald-400",
        down && "text-brand-red-text",
        !up && !down && "text-muted-foreground",
      )}
      title={`${label}: ${value > 0 ? "+" : ""}${value.toFixed(1)} vs. previous grade`}
    >
      <span className="font-medium">{label}</span>
      <Icon className="h-3 w-3" />
      <span className="tabular-nums">
        {value > 0 ? "+" : ""}
        {value.toFixed(1)}
      </span>
    </span>
  );
}

/** A minimal SVG sparkline of the overall score across grades (10-pt scale). */
function OverallSparkline({ points }: { points: ConditionCurvePoint[] }) {
  const scores = points.map((p) => p.overall).filter((s): s is number => s !== null);
  if (scores.length < 2) return null;
  const W = 240;
  const H = 48;
  const PAD = 4;
  const n = points.length;
  const xy = points.map((p, i) => {
    const x = n === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n - 1);
    // Map the 0–10 scale to the plot height (top = 10).
    const s = p.overall ?? 0;
    const y = PAD + (1 - s / 10) * (H - 2 * PAD);
    return { x, y };
  });
  const d = xy
    .map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-12 w-full"
      role="img"
      aria-label="Overall condition score over time"
      preserveAspectRatio="none"
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} className="text-brand-navy" />
      {xy.map((pt, i) => (
        <circle key={i} cx={pt.x} cy={pt.y} r={2.5} className="fill-brand-red" />
      ))}
    </svg>
  );
}

export function ConditionCurve({ points }: { points: ConditionCurvePoint[] }) {
  // A curve needs at least two grades (a re-grade); one grade has nothing to plot.
  if (!points || points.length < 2) return null;

  // Newest first for the per-grade list (the latest condition is what matters most).
  const ordered = [...points].reverse();
  // Guaranteed by the length>=2 guard above (noUncheckedIndexedAccess widens these).
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const netDelta =
    first.overall !== null && last.overall !== null
      ? Math.round((last.overall - first.overall) * 10) / 10
      : null;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">
          Condition over time
        </h2>
        <Badge variant="outline" className="gap-1 font-normal">
          <TrendingDown className="h-3.5 w-3.5" />
          {points.length} grades
        </Badge>
      </div>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center gap-4">
            <div className="text-brand-navy dark:text-foreground">
              <OverallSparkline points={points} />
            </div>
            {netDelta !== null && (
              <div className="shrink-0 text-right">
                <div
                  className={cn(
                    "text-lg font-bold tabular-nums",
                    netDelta > 0 && "text-emerald-600 dark:text-emerald-400",
                    netDelta < 0 && "text-brand-red-text",
                    netDelta === 0 && "text-muted-foreground",
                  )}
                >
                  {netDelta > 0 ? "+" : ""}
                  {netDelta.toFixed(1)}
                </div>
                <div className="text-xs text-muted-foreground">since first grade</div>
              </div>
            )}
          </div>

          <ol className="divide-y">
            {ordered.map((p, i) => (
              <li
                key={`${p.certificate ?? "grade"}-${p.graded_at}-${i}`}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {p.overall !== null && (
                      <span className="text-base font-bold text-brand-red-text tabular-nums">
                        {p.overall.toFixed(1)}
                      </span>
                    )}
                    {p.grade_tier && (
                      <span className="text-sm text-foreground">{p.grade_tier}</span>
                    )}
                    {p.overall_delta !== null && p.overall_delta !== 0 && (
                      <DeltaChip value={p.overall_delta} label="overall" />
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {formatDate(p.graded_at)}
                    {p.certificate && (
                      <>
                        {" · "}
                        <Link
                          to={`/cert/${p.certificate}`}
                          className="inline-flex items-center gap-0.5 font-medium text-brand-navy hover:underline dark:text-blue-400"
                        >
                          Certificate
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      </>
                    )}
                  </div>
                </div>

                {/* Per-factor deltas vs. the prior grade (first grade = baseline). */}
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {FACTORS.map((f) => (
                    <DeltaChip
                      key={f.key}
                      value={p.factor_deltas[f.key]}
                      label={f.label}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ol>

          <p className="border-t pt-3 text-xs text-muted-foreground">
            Each re-grade is an independent, certified condition check. Arrows show
            how each factor changed from the previous grade — so you can see how
            this garment has actually held up.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
