// US-1823: buyer guarantee anti-fraud signal evaluation.
//
// The pure detector scores a claim against a handful of deterministic signals —
// velocity, a repeat-rejection pattern, low Trust Score, thin arrival evidence,
// and a tamper-flagged grade. Above the configured weight it's SUSPICIOUS and
// the US-1821 payout path downgrades it from auto-remedy to manual review. The
// signals are retained on the claim for dispute defense. Unit-tested, no DB.
//
// A full forensic (image-tamper) pass on arrival photos reuses ai-grading's
// detector but costs a vision call per claim, so it's a flag-gated enhancement
// (require_full_arrival_evidence covers the cheap evidence-completeness signal
// here; the deep forensic pass is applied by the caller when enabled).

export interface GuaranteeFraudConfig {
  /** Claims this period above which the velocity signal fires. */
  max_claims_per_period: number;
  /** Prior rejected claims above which the repeat-rejection signal fires. */
  max_recent_rejected: number;
  /** Trust Score level below which auto-payout is withheld. */
  min_trust_level_for_auto: number;
  /** Summed signal weight that routes a claim to manual review. */
  suspicious_score_threshold: number;
  /** A thin arrival photo set is itself a signal. */
  require_full_arrival_evidence: boolean;
}

export const GUARANTEE_FRAUD_SETTING_KEY = "buyer.guarantee_fraud";

export const DEFAULT_GUARANTEE_FRAUD_CONFIG: GuaranteeFraudConfig = {
  max_claims_per_period: 3,
  max_recent_rejected: 2,
  min_trust_level_for_auto: 1,
  suspicious_score_threshold: 3,
  require_full_arrival_evidence: true,
};

function coerceNonNegInt(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  return 0;
}

export function normalizeGuaranteeFraudConfig(raw: unknown): GuaranteeFraudConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_GUARANTEE_FRAUD_CONFIG;
  return {
    max_claims_per_period: coerceNonNegInt(r.max_claims_per_period, d.max_claims_per_period),
    max_recent_rejected: coerceNonNegInt(r.max_recent_rejected, d.max_recent_rejected),
    min_trust_level_for_auto: coerceNonNegInt(r.min_trust_level_for_auto, d.min_trust_level_for_auto),
    suspicious_score_threshold: coerceNonNegInt(r.suspicious_score_threshold, d.suspicious_score_threshold),
    require_full_arrival_evidence: typeof r.require_full_arrival_evidence === "boolean"
      ? r.require_full_arrival_evidence
      : d.require_full_arrival_evidence,
  };
}

export interface FraudInputs {
  /** Claims this buyer has already filed this period (excluding this one). */
  claimsThisPeriod: number;
  /** This buyer's prior REJECTED claims (all-time). */
  recentRejectedClaims: number;
  /** Trust Score level at claim time (US-1817). */
  trustLevel: number;
  /** Did the buyer upload the full arrival photo set (front/back/label/detail)? */
  hasFullArrivalEvidence: boolean;
  /** The graded item's photos were tamper-flagged by grading (image_authenticity). */
  gradeAuthenticityFlagged: boolean;
}

export interface FraudVerdict {
  suspicious: boolean;
  score: number;
  reasons: string[];
}

// Per-signal weights. Velocity + a tamper-flagged grade are the strongest tells;
// low trust / thin evidence are softer. Documented + legible — this IS the policy.
const WEIGHTS = {
  velocity: 2,
  repeat_rejected: 2,
  low_trust: 1,
  thin_evidence: 1,
  grade_tampered: 2,
} as const;

/**
 * Score a claim's fraud signals. PURE. `suspicious` is true when the summed
 * weight reaches the configured threshold — the caller then routes the claim to
 * manual review instead of auto-remedy. Reasons are retained for dispute defense.
 */
export function evaluateFraudSignals(inputs: FraudInputs, config: GuaranteeFraudConfig): FraudVerdict {
  const reasons: string[] = [];
  let score = 0;

  if (inputs.claimsThisPeriod >= config.max_claims_per_period) {
    reasons.push("velocity");
    score += WEIGHTS.velocity;
  }
  if (inputs.recentRejectedClaims >= config.max_recent_rejected) {
    reasons.push("repeat_rejected");
    score += WEIGHTS.repeat_rejected;
  }
  if (inputs.trustLevel < config.min_trust_level_for_auto) {
    reasons.push("low_trust");
    score += WEIGHTS.low_trust;
  }
  if (config.require_full_arrival_evidence && !inputs.hasFullArrivalEvidence) {
    reasons.push("thin_evidence");
    score += WEIGHTS.thin_evidence;
  }
  if (inputs.gradeAuthenticityFlagged) {
    reasons.push("grade_tampered");
    score += WEIGHTS.grade_tampered;
  }

  return {
    suspicious: score >= config.suspicious_score_threshold,
    score,
    reasons,
  };
}
