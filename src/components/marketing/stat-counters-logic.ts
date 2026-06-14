// US-865: pure resolution logic for the live platform stat counters, kept in its
// own module so the component file only exports a component (react-refresh).
//
// The resolver is the honesty gate: it decides which counters are worth showing
// and degrades gracefully when a metric is too small or unavailable. The numbers
// come from the aggregate-only public feed (no per-tenant data); see the edge
// route GET /api/grading/public/stats.

export interface PublicStats {
  generated_at: string;
  items_graded: number;
  verified_sellers: number;
  graded_sales: number;
  // Mean AI-vs-human agreement (share within 0.5 pts). null until the server has
  // a citable sample — we then omit the counter rather than show a misleading %.
  agreement_rate: number | null;
}

// One counter resolved for display. For the degraded "Thousands of …" copy the
// magnitude word is the `display` and the noun moves into `label`.
export interface ResolvedCounter {
  key: string;
  display: string;
  label: string;
}

// Per-metric display config. `exact` is the floor at/above which we show the real
// localized number; below it (down to the qualitative bands) we degrade to
// "Thousands of …"/"Hundreds of …" copy so a growing-but-not-huge metric still
// reads as social proof without publishing a noisy precise figure. The bands sit
// BELOW `exact` so the qualitative copy is actually reachable: e.g. items at
// 1k–25k read "Thousands of items graded"; only past 25k do we show the precise
// count. Small-cohort metrics (verified sellers) set `qualitative: false` and
// simply hide below `exact` rather than be described in vague magnitudes.
function resolveCount(
  value: number,
  exact: number,
  qualitative: boolean,
  label: string,
): { display: string; label: string } | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= exact) return { display: value.toLocaleString("en-US"), label };
  if (qualitative) {
    if (value >= 1000) return { display: "Thousands", label: `of ${label}` };
    if (value >= 100) return { display: "Hundreds", label: `of ${label}` };
  }
  return null;
}

/**
 * Turn the raw aggregate feed into the counters worth rendering, in the story's
 * order — items graded, verified sellers, AI-vs-expert agreement, graded sales
 * tracked. Anything too small or unavailable to cite honestly is dropped, so an
 * empty array means "render nothing" (graceful degradation).
 */
export function resolveCounters(stats: PublicStats | undefined | null): ResolvedCounter[] {
  if (!stats) return [];
  const out: ResolvedCounter[] = [];

  const itemsGraded = resolveCount(stats.items_graded, 25000, true, "items graded");
  if (itemsGraded) out.push({ key: "items_graded", ...itemsGraded });

  const sellers = resolveCount(stats.verified_sellers, 10, false, "verified sellers");
  if (sellers) out.push({ key: "verified_sellers", ...sellers });

  // Server already gates the rate by sample size (null below the bar).
  if (stats.agreement_rate !== null && stats.agreement_rate !== undefined) {
    out.push({
      key: "agreement",
      display: `${Math.round(stats.agreement_rate * 100)}%`,
      label: "AI-vs-expert agreement",
    });
  }

  const sales = resolveCount(stats.graded_sales, 2000, true, "graded sales tracked");
  if (sales) out.push({ key: "graded_sales", ...sales });

  return out;
}
