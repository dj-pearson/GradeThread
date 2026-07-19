// US-2146: accuracy tracking for the authenticity pass.
//
// accuracy-tracking.ts covers grading and contains zero authenticity references,
// so the eval gate (US-2130) is a point-in-time certification with nothing behind
// it: it says a prompt version cleared a bar on one day, and never revisits that
// after a model change, a prompt-version suffix, or a shift in brand mix.
//
// The inputs already exist and were accumulating unused — US-2140 records a
// reviewer verdict against the model verdict it was snapshotted beside.
//
// THE TWO ERROR DIRECTIONS ARE NOT INTERCHANGEABLE, and collapsing them into one
// "accuracy" number is the mistake this module exists to avoid:
//
//   • FALSE NEGATIVE (dangerous miss) — model said likely_authentic, a human
//     confirmed counterfeit. A buyer received a fake we vouched for. This is the
//     error the eval gate fails outright on, and the one a financial guarantee
//     would pay out against.
//   • FALSE POSITIVE — model said red_flags, a human confirmed authentic. A
//     seller's genuine item was publicly flagged. Nobody is reimbursed for this;
//     it is the error US-2145 has no correction path for, and the number the
//     guarantee ADR asks for before underwriting anything.
//
// A single agreement rate can look healthy while either is climbing.

export interface AuthenticityObservation {
  /** The version that produced the model verdict — the attribution key. */
  prompt_version: string | null;
  brand_key: string | null;
  /** likely_authentic | red_flags | inconclusive; null when the pass didn't run. */
  model_verdict: string | null;
  /** authentic | counterfeit | inconclusive. */
  reviewer_verdict: string;
  /** ISO — used to split recent from baseline for drift. */
  reviewed_at: string;
}

export interface AuthenticityAccuracy {
  reviewed: number;
  /** Reviewer and model agreed, after mapping the two vocabularies. */
  agreed: number;
  agreement_rate: number;
  /** Model said likely_authentic, human said counterfeit. Buyer harmed. */
  false_negatives: number;
  false_negative_rate: number;
  /** Model said red_flags, human said authentic. Seller harmed. */
  false_positives: number;
  false_positive_rate: number;
}

export interface AuthenticityAccuracyReport {
  overall: AuthenticityAccuracy;
  by_prompt_version: Record<string, AuthenticityAccuracy>;
  by_brand: Record<string, AuthenticityAccuracy>;
}

/** Map a model verdict onto the reviewer vocabulary, or null when it didn't run. */
export function modelVerdictAsLabel(v: string | null): string | null {
  if (v === "likely_authentic") return "authentic";
  if (v === "red_flags") return "counterfeit";
  if (v === "inconclusive") return "inconclusive";
  return null;
}

function emptyAccuracy(): AuthenticityAccuracy {
  return {
    reviewed: 0,
    agreed: 0,
    agreement_rate: 0,
    false_negatives: 0,
    false_negative_rate: 0,
    false_positives: 0,
    false_positive_rate: 0,
  };
}

function tally(acc: AuthenticityAccuracy, o: AuthenticityObservation): void {
  const asLabel = modelVerdictAsLabel(o.model_verdict);
  // A review of an item the pass never assessed says nothing about the pass.
  if (asLabel === null) return;
  acc.reviewed += 1;
  if (asLabel === o.reviewer_verdict) acc.agreed += 1;
  if (o.model_verdict === "likely_authentic" && o.reviewer_verdict === "counterfeit") {
    acc.false_negatives += 1;
  }
  if (o.model_verdict === "red_flags" && o.reviewer_verdict === "authentic") {
    acc.false_positives += 1;
  }
}

function finalize(acc: AuthenticityAccuracy): AuthenticityAccuracy {
  const n = acc.reviewed;
  const rate = (x: number) => (n > 0 ? Number((x / n).toFixed(4)) : 0);
  acc.agreement_rate = rate(acc.agreed);
  acc.false_negative_rate = rate(acc.false_negatives);
  acc.false_positive_rate = rate(acc.false_positives);
  return acc;
}

/**
 * Accuracy overall, per prompt version, and per brand. Pure + exported.
 *
 * Sliced by prompt_version for the same reason grading attributes accuracy eras:
 * a regression introduced by one version is invisible in a pooled number, and
 * per-brand regression is what blocks activation.
 */
export function computeAuthenticityAccuracy(
  observations: readonly AuthenticityObservation[],
): AuthenticityAccuracyReport {
  const overall = emptyAccuracy();
  const byVersion: Record<string, AuthenticityAccuracy> = {};
  const byBrand: Record<string, AuthenticityAccuracy> = {};

  for (const o of observations) {
    tally(overall, o);
    const v = o.prompt_version ?? "(unattributed)";
    tally((byVersion[v] ??= emptyAccuracy()), o);
    if (o.brand_key) tally((byBrand[o.brand_key] ??= emptyAccuracy()), o);
  }

  finalize(overall);
  for (const a of Object.values(byVersion)) finalize(a);
  for (const a of Object.values(byBrand)) finalize(a);
  return { overall, by_prompt_version: byVersion, by_brand: byBrand };
}

export interface DriftVerdict {
  recent: AuthenticityAccuracy;
  baseline: AuthenticityAccuracy;
  /** True when a rate got materially worse and the sample supports saying so. */
  drifting: boolean;
  reasons: string[];
}

/** Minimum reviews in EACH window before drift is claimed. */
export const MIN_DRIFT_SAMPLE = 20;
/** Absolute rate increase that counts as material. */
export const DRIFT_DELTA = 0.05;

/**
 * Compare a recent window against everything before it. Pure + exported.
 *
 * Drift is judged on the two ERROR rates, not on agreement. Agreement can hold
 * steady while errors trade places — a version that stops flagging fakes and
 * starts flagging genuine items scores the same overall and is much worse.
 *
 * Refuses to call drift on a thin sample: a passing gate declared stale on four
 * reviews would be noise, and a monitor that cries wolf gets muted.
 */
export function detectAuthenticityDrift(
  recent: readonly AuthenticityObservation[],
  baseline: readonly AuthenticityObservation[],
): DriftVerdict {
  const r = computeAuthenticityAccuracy(recent).overall;
  const b = computeAuthenticityAccuracy(baseline).overall;
  const reasons: string[] = [];

  if (r.reviewed < MIN_DRIFT_SAMPLE || b.reviewed < MIN_DRIFT_SAMPLE) {
    return { recent: r, baseline: b, drifting: false, reasons: ["insufficient sample"] };
  }
  if (r.false_negative_rate - b.false_negative_rate >= DRIFT_DELTA) {
    reasons.push(
      `false negatives (fakes called authentic) rose ${b.false_negative_rate} → ${r.false_negative_rate}`,
    );
  }
  if (r.false_positive_rate - b.false_positive_rate >= DRIFT_DELTA) {
    reasons.push(
      `false positives (genuine items flagged) rose ${b.false_positive_rate} → ${r.false_positive_rate}`,
    );
  }
  return { recent: r, baseline: b, drifting: reasons.length > 0, reasons };
}

/**
 * Check for drift and emit an alert if the error profile has worsened.
 *
 * Called after a review outcome is RECORDED rather than from a cron. Two
 * reasons: reviews are the only thing that can move these numbers, so a write is
 * exactly when the answer can change (a schedule would mostly recompute an
 * unchanged result); and the cron fleet is a manual per-environment install, so
 * a scheduled check is one an operator has to remember to turn on before it ever
 * protects anything.
 *
 * Best-effort and never throwing — a monitoring check must not fail the write it
 * observes. Reviews are human-gated and low-volume, so recomputing per write is
 * affordable in a way it would not be on a hot path.
 */
export async function checkAuthenticityDrift(
  loadObservations: () => Promise<AuthenticityObservation[]>,
  cutoffIso: string,
  emit: (name: string, value: number, tags: Record<string, string>) => void,
  warn: (message: string) => void,
): Promise<DriftVerdict | null> {
  try {
    const observations = await loadObservations();
    const { recent, baseline } = splitByCutoff(observations, cutoffIso);
    const verdict = detectAuthenticityDrift(recent, baseline);

    emit("authenticity.false_negative_rate", verdict.recent.false_negative_rate, {
      window: "recent",
    });
    emit("authenticity.false_positive_rate", verdict.recent.false_positive_rate, {
      window: "recent",
    });
    if (verdict.drifting) {
      emit("authenticity.drift_detected", 1, {});
      warn(`[authenticity-drift] ${verdict.reasons.join("; ")}`);
    }
    return verdict;
  } catch {
    return null;
  }
}

/** Split observations into recent vs baseline at a cutoff. Pure + exported. */
export function splitByCutoff(
  observations: readonly AuthenticityObservation[],
  cutoffIso: string,
): { recent: AuthenticityObservation[]; baseline: AuthenticityObservation[] } {
  const cutoff = Date.parse(cutoffIso);
  const recent: AuthenticityObservation[] = [];
  const baseline: AuthenticityObservation[] = [];
  for (const o of observations) {
    const t = Date.parse(o.reviewed_at);
    if (Number.isFinite(t) && t >= cutoff) recent.push(o);
    else baseline.push(o);
  }
  return { recent, baseline };
}
