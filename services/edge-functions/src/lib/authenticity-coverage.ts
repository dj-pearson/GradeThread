// US-2219: how much authentication coverage a brand actually has, and what a
// paid add-on must disclose when it has little.
//
// ── THE MEASUREMENT THE STORY ASKED FOR, AND WHAT IT FOUND ─────────────────
//
// US-2219 assumed tell coverage merely follows brand-pack authoring order —
// luxury first, because that pack came first. The real state is worse and more
// precise: **all 179 seeded authentication_tells payloads are the LEGACY
// {tell, detail} shape.** Zero are structured. coerceTell maps a legacy entry
// to category "other" with no redFlag, so those tells cannot carry a category
// signal and cannot carry a counterfeit marker — they are, in effect, prose the
// prompt reads and the verdict cannot use.
//
// On top of that, CANONICAL_TELLS holds 7 structured tells across 3 brands,
// every one sourced to "seed:brand-authentication-tells (unverified — review in
// admin)".
//
// So the question is not "which brands should we prioritize" — it is "what does
// a PAID add-on owe a buyer when it has almost nothing to check against". That
// is what this module answers. Re-shaping the legacy rows is US-2139's job; this
// one makes the gap visible and stops it degrading silently.
//
// ── SILENT DEGRADATION IS THE ACTUAL DEFECT ────────────────────────────────
//
// The authenticity add-on is PURCHASED. A brand with no actionable tells still
// produced a confident-looking assessment from generic reasoning, and nothing
// in the output said so. That is the part a buyer would object to, and it is
// fixable without any new data.
//
// Pure — no network, no DB, no model.

import type { AuthenticationTell } from "./brand-authenticity.ts";

/**
 * What a brand's tells can actually DO for a verdict.
 *
 *   none        — nothing at all to check against.
 *   inert       — tells exist but every one is category "other" with no red
 *                 flag: prose the prompt can read, not a check it can apply.
 *                 This is the state of every legacy-shaped pack row.
 *   actionable  — at least one tell carries a real category or a red flag.
 */
export type TellCoverageLevel = "none" | "inert" | "actionable";

/**
 * A tell is ACTIONABLE when it can move a verdict: it names a specific category
 * (so a finding can be attributed to stitching vs hardware vs a stamp), or it
 * carries a redFlag (so a counterfeit signal exists to look for).
 *
 * A legacy {tell, detail} row yields neither — coerceTell gives it category
 * "other" and no redFlag — which is why 179 seeded payloads classify as inert.
 */
export function isActionableTell(tell: AuthenticationTell): boolean {
  return tell.category !== "other" || !!tell.redFlag;
}

export interface TellCoverage {
  level: TellCoverageLevel;
  total: number;
  actionable: number;
  /** Distinct non-"other" categories represented. */
  categories: string[];
}

export function classifyTellCoverage(
  tells: readonly AuthenticationTell[],
): TellCoverage {
  const actionable = tells.filter(isActionableTell);
  const categories = [
    ...new Set(tells.map((t) => t.category).filter((c) => c !== "other")),
  ].sort();
  const level: TellCoverageLevel = tells.length === 0
    ? "none"
    : actionable.length === 0
    ? "inert"
    : "actionable";
  return { level, total: tells.length, actionable: actionable.length, categories };
}

/**
 * Confidence ceiling implied by the coverage level. Composes by MIN with the
 * reference cap (US-2218) and can only lower — never raise.
 *
 * Two bands again, and for the same reason as US-2218: we know an assessment
 * with nothing to check against rested on generic reasoning, and we do not know
 * how much that costs. A gradient here would fabricate a precision the golden
 * set (US-2131) has not yet measured.
 */
export const COVERAGE_CAP_NONE = 0.6;
export const COVERAGE_CAP_INERT = 0.75;

export function coverageConfidenceCap(level: TellCoverageLevel): number {
  if (level === "none") return COVERAGE_CAP_NONE;
  if (level === "inert") return COVERAGE_CAP_INERT;
  return 1;
}

/**
 * The disclosure a PAID assessment owes its buyer. Returns "" for actionable
 * coverage, keeping the limitations string byte-identical to today.
 *
 * Written in terms of what WE hold, never in terms of the garment. The item is
 * not more suspicious because our knowledge base is thin.
 */
export function coverageLimitation(coverage: TellCoverage): string {
  if (coverage.level === "actionable") return "";
  if (coverage.level === "none") {
    return " We hold no brand-specific authentication criteria for this brand, so this assessment rests on general construction and finishing cues rather than on verified brand tells. Treat it as a starting point for your own inspection, not as a brand-specific authentication.";
  }
  return " Our brand-specific criteria for this brand are descriptive notes rather than checkable tests, so no finding here is attributed to a specific verified marker. Treat it as a starting point for your own inspection.";
}

/**
 * Whether the add-on should be OFFERED for this brand at all, given what we
 * hold. Returns the disclosure a purchase flow must show when coverage is thin.
 *
 * DELIBERATELY NOT A HARD BLOCK. Refusing the sale outright would be the other
 * defensible answer, and it is a product decision rather than an engineering
 * one — a general construction-and-finishing assessment has real value to some
 * buyers even without brand tells. What is NOT defensible is charging for it
 * while implying brand-specific authentication, so the disclosure is mandatory
 * and the caller cannot render the offer without it.
 */
export function purchaseDisclosure(coverage: TellCoverage): string | null {
  if (coverage.level === "actionable") return null;
  if (coverage.level === "none") {
    return "We hold no brand-specific authentication criteria for this brand yet. This add-on will assess general construction and finishing only, and its confidence is capped accordingly.";
  }
  return "Our criteria for this brand are descriptive rather than checkable, so findings will not be tied to specific verified markers. Confidence is capped accordingly.";
}
