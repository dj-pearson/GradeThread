// US-1600 / AGENTIC-OS Phase 1 (Module U): the User Lifecycle agent's pure core.
//
// Judgment on TOP of the drip engine, not a second sender. It reads COHORT-LEVEL
// lifecycle data — activation funnels, drip enroll/convert/churn by week, trial-
// expiry buckets — and explains WHERE users stall + sizes winback opportunity.
// THE COHORT RULE (AGENTIC_OS §3.U): the tool layer AGGREGATES before the model
// ever sees anything; no per-user row, id, or PII reaches a transcript. This file
// only ever handles counts + rates.
//
// PURE + fixture-tested. All sends still flow through the drip engine + the
// marketing-frequency caps; this agent proposes cohort-level moves, never a send.

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
}

// One week's drip cohort rollup (counts only).
export interface CohortWeek {
  week: string; // ISO date of the week start
  enrolled: number;
  converted: number;
  churned: number; // exited without converting
}

// A trial-expiry bucket (counts only).
export interface TrialCohort {
  bucket: string; // e.g. "expiring_3d" | "expiring_7d" | "expired_unconverted"
  count: number;
}

// ── Activation-stall diagnosis ────────────────────────────────────────────────

export interface ActivationStall {
  step_from: string;
  step_to: string;
  retained_rate: number; // fraction that made it from step_from → step_to
  drop_count: number; // how many were lost at this transition
  hypothesis: string;
}

// The worst consecutive-step transition in the activation funnel is the stall.
// Returns null when the funnel is too small or fully healthy (no real drop).
export function diagnoseActivationStall(
  funnel: readonly FunnelStep[],
  opts: { minRetained?: number } = {},
): ActivationStall | null {
  const minRetained = opts.minRetained ?? 0.7; // ≥70% through a step = healthy
  if (funnel.length < 2) return null;
  let worst: ActivationStall | null = null;
  for (let i = 1; i < funnel.length; i++) {
    const from = funnel[i - 1], to = funnel[i];
    if (from.count <= 0) continue;
    const retained = to.count / from.count;
    if (retained >= minRetained) continue; // this step is fine
    if (worst === null || retained < worst.retained_rate) {
      worst = {
        step_from: from.key,
        step_to: to.key,
        retained_rate: Number(retained.toFixed(4)),
        drop_count: Math.max(0, from.count - to.count),
        hypothesis: `Only ${(retained * 100).toFixed(0)}% of "${from.label}" reached "${to.label}" — the ${to.label.toLowerCase()} step is where this cohort stalls.`,
      };
    }
  }
  return worst;
}

// ── Churn-risk narrative (this week vs prior) ─────────────────────────────────

export type ChurnRisk = "improving" | "steady" | "worsening" | "unknown";

export interface ChurnNarrative {
  risk: ChurnRisk;
  conversion_rate: number | null;
  prior_conversion_rate: number | null;
  churn_rate: number | null;
  narrative: string;
}

function rate(n: number, d: number): number | null {
  return d > 0 ? Number((n / d).toFixed(4)) : null;
}

const CHURN_BAND = 0.1; // ±10% relative change is "steady"

export function narrateChurnRisk(current: CohortWeek, prior: CohortWeek): ChurnNarrative {
  const conv = rate(current.converted, current.enrolled);
  const priorConv = rate(prior.converted, prior.enrolled);
  const churn = rate(current.churned, current.enrolled);
  let risk: ChurnRisk = "unknown";
  if (conv !== null && priorConv !== null && priorConv > 0) {
    const rel = (conv - priorConv) / priorConv;
    // Conversion UP → improving; conversion DOWN → worsening.
    risk = rel > CHURN_BAND ? "improving" : rel < -CHURN_BAND ? "worsening" : "steady";
  }
  const convStr = conv !== null ? `${(conv * 100).toFixed(1)}%` : "n/a";
  const priorStr = priorConv !== null ? `${(priorConv * 100).toFixed(1)}%` : "n/a";
  return {
    risk,
    conversion_rate: conv,
    prior_conversion_rate: priorConv,
    churn_rate: churn,
    narrative: `Conversion ${convStr} vs ${priorStr} last week (${risk}); ${current.churned} of ${current.enrolled} enrolled churned.`,
  };
}

// ── Winback sizing ────────────────────────────────────────────────────────────

export interface WinbackSizing {
  reachable: number; // expired-unconverted cohort size (the winback pool)
  expiring_soon: number; // still-savable trials expiring within the window
  note: string;
}

export function sizeWinback(trialCohorts: readonly TrialCohort[]): WinbackSizing {
  const by = new Map<string, number>();
  for (const c of trialCohorts) by.set(c.bucket, (by.get(c.bucket) ?? 0) + c.count);
  const reachable = by.get("expired_unconverted") ?? 0;
  let expiringSoon = 0;
  for (const [bucket, n] of by) if (bucket.startsWith("expiring_")) expiringSoon += n;
  return {
    reachable,
    expiring_soon: expiringSoon,
    note: `${reachable} expired-unconverted reachable for winback; ${expiringSoon} still-savable trials expiring soon.`,
  };
}

// ── Assembled memo ────────────────────────────────────────────────────────────

export interface LifecycleMemo {
  summary: string;
  activation_stall: ActivationStall | null;
  churn: ChurnNarrative;
  winback: WinbackSizing;
  all_clear: boolean; // no stall, churn not worsening, no winback pool
}

export function assembleLifecycleMemo(
  funnel: readonly FunnelStep[],
  current: CohortWeek,
  prior: CohortWeek,
  trialCohorts: readonly TrialCohort[],
): LifecycleMemo {
  const stall = diagnoseActivationStall(funnel);
  const churn = narrateChurnRisk(current, prior);
  const winback = sizeWinback(trialCohorts);
  const allClear = stall === null && churn.risk !== "worsening" && winback.reachable === 0;
  const parts: string[] = [];
  parts.push(stall ? `stall at ${stall.step_to} (${(stall.retained_rate * 100).toFixed(0)}% through)` : "no activation stall");
  parts.push(`churn ${churn.risk}`);
  if (winback.reachable > 0) parts.push(`${winback.reachable} winback-reachable`);
  return { summary: parts.join("; ") + ".", activation_stall: stall, churn, winback, all_clear: allClear };
}
