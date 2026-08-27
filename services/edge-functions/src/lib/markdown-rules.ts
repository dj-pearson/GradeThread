// US-2950: a standing rule that marks down aged stock.
//
// Markdown sales could be created, edited and ended, and nothing scheduled one.
// So dead stock discounted itself only when the seller remembered — which, for
// the seller who most needs it, is never.
//
// The third sibling of lib/offer-rules.ts and lib/return-rules.ts: stored as
// flipdesk_automation_rules rows, executed by a step in the SAME hourly cron.
// Same lock, same plan gate, no new job.
//
// ── THE FLOOR EXCLUDES, IT DOES NOT CLAMP ───────────────────────────────────
//
// An item whose markdown would breach the margin floor is left OUT of the sale.
// It is not discounted to the floor instead. Two reasons, and the second is the
// one that matters:
//
//   1. A markdown sale is one percentage across a set. There is no per-item
//      percentage to clamp TO — eBay applies the sale's number, not ours.
//   2. Quietly discounting an item to a different number than the rule says is
//      how a seller stops being able to predict what their own automation does.
//
// ── AND THE GRADE FLOOR ─────────────────────────────────────────────────────
//
// A minimum grade, because condition is the thing FlipDesk knows that a
// marketplace does not. A seller clearing shelf-warmers usually does not want
// their best-condition pieces in the same 30%-off bucket, and the alternative —
// excluding them by hand every time — is the reason the rule goes unused.
//
// Pure. The eBay call and the database reads live in the runner.

import { clampMarkdownPct } from "./ebay-marketing.ts";

export interface MarkdownRuleConfig {
  /** Only items listed at least this long. */
  minDaysListed: number;
  /** Percent off. Clamped to eBay's bounds by the shared clamp. */
  markdownPct: number;
  /** Minimum margin over acquisition cost the marked-down price must clear. */
  marginFloorPct: number;
  /**
   * Items graded below this are excluded. Null includes every grade, INCLUDING
   * ungraded items — see selectMarkdownItems for why that direction is safe.
   */
  minGrade: number | null;
}

export interface MarkdownCandidate {
  listingId: string;
  title: string | null;
  priceCents: number | null;
  costCents: number | null;
  daysListed: number | null;
  /** The assigned overall grade, or null when the item was never graded here. */
  grade: number | null;
}

export type MarkdownExclusion =
  | "too_new"
  | "below_margin_floor"
  | "below_min_grade"
  | "no_price";

export interface MarkdownSelection {
  included: MarkdownCandidate[];
  excluded: Array<{ item: MarkdownCandidate; reason: MarkdownExclusion }>;
  /** The worst-case discount exposure of the included set, in cents. */
  exposureCents: number;
}

/**
 * Which items the rule would put in the sale. Pure.
 *
 * ORDER OF EXCLUSION IS THE CONTRACT, cheapest check first so the reported
 * reason is the one a seller would give:
 *   1. No price — nothing to discount, and no way to check the floor.
 *   2. Too new.
 *   3. Below the minimum grade.
 *   4. Below the margin floor.
 *
 * An item with NO recorded cost passes the floor check rather than failing it.
 * That is the opposite direction from the offer rules, deliberately: an offer
 * rule SELLS at a price and an unknown cost there risks selling under water,
 * while a markdown only makes an item cheaper to buy — a seller running a
 * clearance sale who found half their stock silently excluded for missing a
 * purchase price would conclude the feature was broken.
 *
 * An UNGRADED item passes the grade check for the same reason.
 */
export function selectMarkdownItems(
  cfg: MarkdownRuleConfig,
  items: MarkdownCandidate[],
): MarkdownSelection {
  const pct = clampMarkdownPct(cfg.markdownPct);
  const included: MarkdownCandidate[] = [];
  const excluded: Array<{ item: MarkdownCandidate; reason: MarkdownExclusion }> = [];

  for (const item of items) {
    if (item.priceCents == null || item.priceCents <= 0) {
      excluded.push({ item, reason: "no_price" });
      continue;
    }
    if (item.daysListed == null || item.daysListed < cfg.minDaysListed) {
      excluded.push({ item, reason: "too_new" });
      continue;
    }
    if (cfg.minGrade != null && item.grade != null && item.grade < cfg.minGrade) {
      excluded.push({ item, reason: "below_min_grade" });
      continue;
    }
    if (item.costCents != null && item.costCents > 0) {
      const discounted = Math.round(item.priceCents * (1 - pct / 100));
      const floor = Math.round(item.costCents * (1 + cfg.marginFloorPct / 100));
      if (discounted < floor) {
        excluded.push({ item, reason: "below_margin_floor" });
        continue;
      }
    }
    included.push(item);
  }

  return {
    included,
    excluded,
    exposureCents: included.reduce(
      (sum, i) => sum + Math.round((i.priceCents ?? 0) * (pct / 100)),
      0,
    ),
  };
}

/** The reason, in the seller's words. Pure, so the copy is testable. */
export function describeExclusion(reason: MarkdownExclusion): string {
  switch (reason) {
    case "no_price":
      return "no price on record";
    case "too_new":
      return "not old enough yet";
    case "below_min_grade":
      return "graded above your cut-off, so it is kept out of the sale";
    case "below_margin_floor":
      return "the discount would take it under your cost floor";
  }
}
