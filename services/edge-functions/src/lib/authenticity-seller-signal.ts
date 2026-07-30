// US-2148: per-seller authenticity aggregation, for operators.
//
// Nothing aggregated authenticity across a seller's items, so three red-flag
// findings on one seller looked exactly like three findings on three sellers.
// That is the shape vault/60-decisions/adr-authenticity-guarantee.md names as
// the one our claims budget handles worst — fakes arrive in correlated batches
// from a single source, and a per-period budget absorbs independent claims well
// and bursts badly.
//
// Two deliberate constraints:
//
//   • This does NOT write to reputation_events. That log is the BUYER Trust
//     Score (00417); its perks are buyer-side. Seller conduct is a different
//     subject and routing it there would express a seller penalty as a change to
//     that person's buyer reward multiplier, which means nothing.
//   • The adverse signal is CONFIRMED findings — a human review outcome — not
//     raw model verdicts. The pass has no measured error rate, so an automated
//     seller-adverse signal off an ungated verdict is US-2145 with consequences.
//     Model verdicts are still counted, but separately and labelled as such.

export interface SellerAuthenticityRecord {
  seller_id: string;
  /** ISO timestamp of the assessment. */
  occurred_at: string;
  /** The pass's coarse verdict. */
  model_verdict: string | null;
  /** A human's verdict, when the item was reviewed. Null when never reviewed. */
  reviewer_verdict: string | null;
}

export interface SellerAuthenticitySignal {
  seller_id: string;
  assessed: number;
  /** Model said red_flags. Indicative only — the pass is not gated. */
  model_flagged: number;
  /** A human confirmed counterfeit. This is the load-bearing number. */
  confirmed_counterfeit: number;
  /** A human reviewed and cleared it — evidence the flags were false alarms. */
  confirmed_authentic: number;
  /** Most recent confirmed counterfeit, ISO. Null when none. */
  last_confirmed_at: string | null;
  /**
   * Largest number of CONFIRMED counterfeits inside any rolling window. This is
   * the batch signature: five over two years is a bad streak, five in a week is
   * one consignment.
   */
  peak_cluster: number;
  /** True when the cluster crosses the threshold — worth an operator's look. */
  clustered: boolean;
}

/** Rolling window used to detect a batch, in days. */
export const CLUSTER_WINDOW_DAYS = 30;
/** Confirmed counterfeits inside the window that constitute a cluster. */
export const CLUSTER_THRESHOLD = 3;

const DAY_MS = 86_400_000;

/**
 * Aggregate per seller. Pure + exported.
 *
 * `nowMs` is injected rather than read from the clock so the result is
 * deterministic and testable (and because Date.now is unavailable in some
 * execution contexts here).
 */
export function summarizeSellerAuthenticity(
  records: readonly SellerAuthenticityRecord[],
): SellerAuthenticitySignal[] {
  const bySeller = new Map<string, SellerAuthenticityRecord[]>();
  for (const r of records) {
    if (!r.seller_id) continue;
    const list = bySeller.get(r.seller_id) ?? [];
    list.push(r);
    bySeller.set(r.seller_id, list);
  }

  const out: SellerAuthenticitySignal[] = [];
  for (const [sellerId, rows] of bySeller) {
    const confirmedTimes: number[] = [];
    let modelFlagged = 0;
    let confirmedCounterfeit = 0;
    let confirmedAuthentic = 0;

    for (const r of rows) {
      if (r.model_verdict === "red_flags") modelFlagged += 1;
      if (r.reviewer_verdict === "counterfeit") {
        confirmedCounterfeit += 1;
        const t = Date.parse(r.occurred_at);
        if (Number.isFinite(t)) confirmedTimes.push(t);
      } else if (r.reviewer_verdict === "authentic") {
        confirmedAuthentic += 1;
      }
    }

    confirmedTimes.sort((a, b) => a - b);
    const peak = peakClusterSize(confirmedTimes, CLUSTER_WINDOW_DAYS * DAY_MS);

    out.push({
      seller_id: sellerId,
      assessed: rows.length,
      model_flagged: modelFlagged,
      confirmed_counterfeit: confirmedCounterfeit,
      confirmed_authentic: confirmedAuthentic,
      last_confirmed_at: confirmedTimes.length > 0
        ? new Date(confirmedTimes[confirmedTimes.length - 1]!).toISOString()
        : null,
      peak_cluster: peak,
      clustered: peak >= CLUSTER_THRESHOLD,
    });
  }

  // Clustered sellers first, then most confirmed — an operator should meet the
  // batch signature before a long tail of single findings.
  out.sort((a, b) =>
    Number(b.clustered) - Number(a.clustered) ||
    b.confirmed_counterfeit - a.confirmed_counterfeit ||
    a.seller_id.localeCompare(b.seller_id)
  );
  return out;
}

/**
 * US-2148 AC5: is this seller in the middle of a correlated batch RIGHT NOW?
 *
 * The operator view (above) slides a window over all history to rank sellers.
 * A guarantee claim asks a narrower question — the ADR's flaw #2 is that the
 * claims budget "handles correlated bursts worst — the breaker trips AFTER the
 * batch has already drawn down, so the protection arrives late by construction."
 * The fix is a leading indicator, so the window here is anchored to now: how
 * many of this seller's items has a human confirmed counterfeit in the last
 * CLUSTER_WINDOW_DAYS. Same threshold as the console on purpose — an operator
 * triaging a held claim should see the same number that caused the hold.
 *
 * PURE (nowMs injected). Timestamps are the ASSESSMENT time, not the review
 * time; see the caller for why.
 */
export function correlatedBatchHold(
  confirmedAtMs: readonly number[],
  nowMs: number,
): { held: boolean; confirmedInWindow: number } {
  const windowMs = CLUSTER_WINDOW_DAYS * DAY_MS;
  let confirmedInWindow = 0;
  for (const t of confirmedAtMs) {
    if (!Number.isFinite(t)) continue;
    // Not upper-bounded: a report stamped a moment into the future by clock skew
    // is part of the batch, and excluding it would under-count the live case.
    if (nowMs - t <= windowMs) confirmedInWindow += 1;
  }
  return { held: confirmedInWindow >= CLUSTER_THRESHOLD, confirmedInWindow };
}

/**
 * Largest count of timestamps inside any window of `windowMs`. Pure + exported.
 * Two-pointer over the sorted list — a fixed calendar bucket would split a batch
 * that straddles a boundary and miss exactly the case this exists to catch.
 */
export function peakClusterSize(sortedTimes: readonly number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < sortedTimes.length; end++) {
    while (sortedTimes[end]! - sortedTimes[start]! > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}
