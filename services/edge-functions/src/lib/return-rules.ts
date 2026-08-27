// US-2938: auto-approve and auto-refund rules for incoming returns.
//
// Every return was answered by hand. At any volume that is the bottleneck, and
// it is worse than it sounds because eBay runs a clock: an unanswered return is
// not a deferred decision, it is an automatic refund plus a late-response mark
// against the seller.
//
// This is the return-shaped sibling of lib/offer-rules.ts and follows the same
// shape for the same reasons: rules stored as ordinary flipdesk_automation_rules
// rows (no migration — trigger_json and action_json are jsonb), executed by a
// step inside the EXISTING hourly automation-rules cron. Same lock, same plan
// gate, same cadence, no cron-registry change.
//
// ── THE ONE THING THIS MUST NEVER DO ────────────────────────────────────────
//
// Auto-answer a condition complaint. A "not as described" return is the seller
// saying nothing while a buyer's account of the garment goes on the record, and
// it is the only return type where the grade report is an argument (US-2935).
// So SNAD is a HARD SKIP that no configuration can turn off. It is checked
// before any threshold, and there is no flag to disable the check — a rule that
// could auto-approve a SNAD would be a rule that silently concedes the one
// dispute the product exists to win.
//
// ── WHY AUTO-APPROVE IS THE SAFE DIRECTION ──────────────────────────────────
//
// Approving a return the seller was always going to approve costs the seller
// nothing but the postage they were going to pay anyway, and it SAVES the
// late-response mark. Declining is the move that needs a human: it puts the
// seller on record refusing, and a wrongly-declined return escalates into a
// case, which carries a defect. So there is no auto-decline here, and adding
// one would be a different and much worse feature.

import { isSnadReason } from "./post-sale-analytics.ts";

/** What the runner should do with one return. */
export type ReturnRuleDecision = "approve" | "refund_keep" | "skip";

export interface ReturnRuleConfig {
  /**
   * Auto-approve a return at or below this order total, in cents.
   * Null disables approving.
   */
  approveAtOrBelowCents: number | null;
  /**
   * Refund WITHOUT asking for the item back, at or below this order total, in
   * cents. Null disables it.
   *
   * Below the approve threshold by construction (see decideReturnRule): paying
   * return postage on a garment worth less than the label is the case this
   * exists for, and it only makes sense on the cheapest end of the range.
   */
  refundWithoutReturnAtOrBelowCents: number | null;
}

export interface ReturnRuleFacts {
  /** eBay's stated reason. */
  reason: string | null;
  /** The order total, in cents. Null when unknown. */
  orderTotalCents: number | null;
  /** eBay's return state, so a settled return is never re-answered. */
  state: string | null;
}

export interface ReturnRuleOutcome {
  decision: ReturnRuleDecision;
  /** Why, in the seller's words. Logged and shown in the dry run. */
  reason: string;
}

/** Bounds a seller may set, in whole dollars. Wider is not more useful. */
export const MIN_RETURN_THRESHOLD_CENTS = 100;
export const MAX_RETURN_THRESHOLD_CENTS = 100_000;

/**
 * Normalize a threshold a seller typed, in cents. Null means "not set", which
 * disables that half of the rule — the same blank-means-blank discipline
 * US-2405 forced on the best-offer thresholds.
 */
export function normalizeThresholdCents(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const cents = Math.trunc(n);
  if (cents < MIN_RETURN_THRESHOLD_CENTS) return null;
  return Math.min(cents, MAX_RETURN_THRESHOLD_CENTS);
}

/** Return states that mean the seller has nothing left to decide. */
const SETTLED_MARKERS = [
  "CLOSED",
  "COMPLETED",
  "REFUNDED",
  "DECLINED",
  "APPROVED",
  "CANCELLED",
  "CANCELED",
];

/**
 * Decide what to do with one return. Pure.
 *
 * ORDER IS THE CONTRACT, and every step before the thresholds is a refusal:
 *   1. Already settled → skip. Nothing to answer.
 *   2. SNAD → skip. Hard, unconfigurable; see the header.
 *   3. Unknown order total → skip. A threshold cannot be applied to a number
 *      we do not have, and defaulting it to zero would auto-approve everything.
 *   4. Refund-without-return, checked BEFORE approve, because it is the
 *      narrower band and the seller set it deliberately.
 *   5. Approve.
 */
export function decideReturnRule(
  cfg: ReturnRuleConfig,
  facts: ReturnRuleFacts,
): ReturnRuleOutcome {
  const state = (facts.state ?? "").toUpperCase();
  if (state && SETTLED_MARKERS.some((m) => state.includes(m))) {
    return { decision: "skip", reason: "eBay has already settled this return." };
  }
  if (isSnadReason(facts.reason)) {
    return {
      decision: "skip",
      reason: "Not-as-described returns are always answered by a person.",
    };
  }
  if (facts.orderTotalCents == null || !Number.isFinite(facts.orderTotalCents)) {
    return { decision: "skip", reason: "The order total is unknown, so no rule can apply." };
  }

  const total = facts.orderTotalCents;
  const keepAt = cfg.refundWithoutReturnAtOrBelowCents;
  if (keepAt != null && total <= keepAt) {
    return {
      decision: "refund_keep",
      reason: `Refunded without asking for it back — the order is ${
        formatCents(total)
      }, at or under your ${formatCents(keepAt)} keep-it limit.`,
    };
  }
  const approveAt = cfg.approveAtOrBelowCents;
  if (approveAt != null && total <= approveAt) {
    return {
      decision: "approve",
      reason: `Approved automatically — the order is ${formatCents(total)}, at or under your ${
        formatCents(approveAt)
      } limit.`,
    };
  }
  return { decision: "skip", reason: "The order is above every limit you set." };
}

/** Whole currency, for the sentence a seller reads. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface DryRunSummary {
  considered: number;
  wouldApprove: number;
  wouldRefundKeep: number;
  skipped: number;
  /** Per-return lines, so a seller sees the actual items before enabling. */
  lines: Array<{ externalId: string; decision: ReturnRuleDecision; reason: string }>;
}

/**
 * What the rule WOULD have done over a set of returns. Pure.
 *
 * The dry run is not a nicety: these rules refund buyers, and a seller who
 * cannot see the item list before switching one on is being asked to trust a
 * number they typed against data they have not looked at.
 */
export function dryRunReturnRule(
  cfg: ReturnRuleConfig,
  returns: Array<ReturnRuleFacts & { externalId: string }>,
): DryRunSummary {
  const summary: DryRunSummary = {
    considered: returns.length,
    wouldApprove: 0,
    wouldRefundKeep: 0,
    skipped: 0,
    lines: [],
  };
  for (const r of returns) {
    const outcome = decideReturnRule(cfg, r);
    if (outcome.decision === "approve") summary.wouldApprove++;
    else if (outcome.decision === "refund_keep") summary.wouldRefundKeep++;
    else summary.skipped++;
    summary.lines.push({
      externalId: r.externalId,
      decision: outcome.decision,
      reason: outcome.reason,
    });
  }
  return summary;
}
