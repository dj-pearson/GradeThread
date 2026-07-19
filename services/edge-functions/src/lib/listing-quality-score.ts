// Listing Quality Score (US-1897) — one 0–100 number per listing, plus the
// breakdown that says which fix earns the most points.
//
// SOURCE OF TRUTH FOR WEIGHTS: vault/30-platform/ebay-ranking-playbook.md (verified 2026-07-09).
// That doc deliberately publishes NO numeric weights, so the numbers below are a
// judgement call — but the ORDERING is not, and each weight cites the section it
// comes from. If the playbook is revised, revise these with it.
//
//   aspects      30  §1 "complete Required + Recommended aspects is the single
//                       highest-confidence lever"; a missing aspect "silently
//                       removes the listing from every filtered result"
//   photos       25  §6 first photo is the search thumbnail, "biggest CTR lever";
//                       500px hard floor, 1600px for zoom
//   title        15  §1/§2 policy-clean and genuinely searchable (see the lore
//                       caveat below — this is NOT a character-count target)
//   category     12  §1 wrong/non-leaf category loses the filtered results
//                       entirely; leaf + agreement with eBay's own suggestion
//   fulfillment  10  §4 eBay-CONFIRMED: returns accepted, ≤1-day handling, free
//                       shipping ("can give your fixed price listing a boost")
//   condition     8  §4/US-1894 tier/description consistency
//
// ── WHAT THIS SCORE REFUSES TO MEASURE (AC3) ──────────────────────────────
// The playbook's §10 lists things sellers believe are ranking factors and are
// not. None of them appear here, and none should be added:
//   • Best Offer as a direct ranking signal
//   • relist freshness / "new listing boost" farming
//   • the "first 35 characters weigh more" positional rule
//   • keyword stemming tricks, HTML templates
//
// The subtle one is TITLE LENGTH. AC1 asks for "title … utilization", and the
// obvious reading — reward titles near 80 chars — is precisely the vendor lore
// §2 flags as NOT an eBay statement. So the title component scores what is
// actually defensible: policy cleanliness (US-1890, a real publish blocker) and
// whether the title carries enough searchable text to match queries at all. A
// very short title genuinely cannot match many searches. A 72-character title is
// NOT ranked above a 68-character one here, and there is no optimal band.
//
// ── UNKNOWN SIGNALS ARE EXCLUDED, NOT PENALISED ───────────────────────────
// A component whose inputs we could not read (no synced business policy, an
// uncached category) is dropped from BOTH the numerator and the denominator and
// the score is rescaled over what remains. Scoring an unreadable signal as zero
// would tell a seller to fix something that may already be correct, and would
// make the score drift with our sync health rather than their listing quality.

import type { FulfillmentSignals } from "./business-policy-signals.ts";

export type ComponentStatus = "ok" | "warn" | "fix" | "unknown";

export interface QualityComponent {
  key: string;
  label: string;
  /** Nominal weight out of 100 (before unknown-component rescaling). */
  weight: number;
  /** Points earned, 0..weight. Always 0 when status is "unknown". */
  earned: number;
  status: ComponentStatus;
  /** One line the UI shows under the component. */
  detail: string;
  /** AC2: where the seller goes to fix this. */
  fixSurface: string;
  /** This component alone stops the listing publishing (caps the whole score). */
  blocking?: boolean;
}

export interface ListingQualityScore {
  /** 0–100, rescaled over components with a readable signal, blocker-capped. */
  score: number;
  components: QualityComponent[];
  /** Sum of weights actually counted (100 when every signal was readable). */
  weightCounted: number;
  /** Highest-value fixes first — what the UI should nag about. */
  topFixes: { key: string; label: string; pointsAvailable: number; fixSurface: string }[];
  /** True when something here stops the listing going live at all. */
  blocked: boolean;
  /** Why it is blocked, in the seller's words. */
  blockingReasons: string[];
}

// A listing that CANNOT PUBLISH cannot rank, so its score is capped here no
// matter how good the rest of it is.
//
// This exists because the additive score lied. A listing missing one required
// item specific scored 70 — a solid B — while eBay would refuse to list it at
// all; a non-leaf category scored 88 for a listing that cannot exist. A seller
// triaging 300 drafts by score would have sorted those to the bottom of the
// "fine" pile and never looked. The cap is deliberately below any passing band
// so a blocked listing sorts with the wreckage, which is where it belongs.
export const BLOCKED_SCORE_CEILING = 40;

export interface QualityScoreInput {
  title: {
    text: string | null;
    policyViolations: readonly string[];
    warnings: readonly string[];
  };
  aspects: {
    /** From requiredMissingAspects() — any entry is a publish blocker. */
    requiredMissing: readonly string[];
    /** From recommendedAspectCoverage(). total 0 ⇒ category has none. */
    recommendedFilled: number;
    recommendedTotal: number;
  };
  photos: {
    /** From photoStandardsPreflight(). */
    blockers: readonly string[];
    warnings: readonly string[];
    nudge: string | null;
    count: number;
  };
  category: {
    /** From resolveCategoryLeafStatus(). */
    leafStatus: "leaf" | "non_leaf" | "not_found" | "unverified";
    /** chosen === eBay's top suggestion. null when no suggestion was fetched. */
    matchesSuggestion: boolean | null;
  };
  condition: {
    /** From conditionDescriptionConsistency(); null when no condition resolved. */
    consistent: boolean | null;
    warnings: readonly string[];
  };
  fulfillment: FulfillmentSignals;
}

export const QUALITY_WEIGHTS = {
  aspects: 30,
  photos: 25,
  title: 15,
  category: 12,
  fulfillment: 10,
  condition: 8,
} as const;

/** Titles shorter than this cannot carry enough terms to match many queries. */
const TITLE_THIN_CHARS = 30;
/** eBay's hard cap; used only to detect an over-long title, never as a target. */
const TITLE_MAX = 80;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function scoreTitle(t: QualityScoreInput["title"]): QualityComponent {
  const w = QUALITY_WEIGHTS.title;
  const base = {
    key: "title",
    label: "Title",
    weight: w,
    fixSurface: "composer.title",
  };
  const text = (t.text ?? "").trim();
  if (!text) {
    return { ...base, earned: 0, status: "fix", blocking: true, detail: "No title." };
  }
  // A policy violation is a publish blocker (US-1890) — zero, not a deduction.
  if (t.policyViolations.length) {
    return {
      ...base,
      earned: 0,
      status: "fix",
      blocking: true,
      detail: `Blocked by listing policy: ${t.policyViolations[0]}`,
    };
  }
  // Annotated: QUALITY_WEIGHTS is `as const`, so `w` is a literal type and an
  // unannotated `let` would narrow to it and reject the clamp below.
  let earned: number = w;
  const notes: string[] = [];
  // Lint warnings (filler words, duplicate tokens, ALL CAPS) cost real search
  // relevance — they spend characters that could carry a search term.
  if (t.warnings.length) {
    earned -= Math.min(w * 0.4, t.warnings.length * (w * 0.15));
    notes.push(t.warnings[0]);
  }
  if (text.length > TITLE_MAX) {
    // Will be trimmed on publish (title-trim.ts) — the seller loses the tail
    // rather than choosing what to drop.
    earned -= w * 0.2;
    notes.push(`Over ${TITLE_MAX} characters — the end will be trimmed.`);
  } else if (text.length < TITLE_THIN_CHARS) {
    // NOT a length target: only a floor below which there is too little
    // searchable text to match queries. See the lore caveat in the header.
    earned -= w * 0.3;
    notes.push("Very short — too few search terms to match many buyer queries.");
  }
  earned = clamp(earned, 0, w);
  return {
    ...base,
    earned,
    status: earned >= w ? "ok" : earned >= w * 0.6 ? "warn" : "fix",
    detail: notes.length ? notes.join(" ") : "Policy-clean and specific.",
  };
}

function scoreAspects(a: QualityScoreInput["aspects"]): QualityComponent {
  const w = QUALITY_WEIGHTS.aspects;
  const base = {
    key: "aspects",
    label: "Item specifics",
    weight: w,
    fixSurface: "composer.aspects",
  };
  // Required aspects are a publish blocker AND remove the listing from every
  // filtered search (§1) — they take the larger share of the component.
  // 0.25, not 0.55: having no MISSING required aspect is table stakes — it is a
  // publish blocker otherwise — so paying most of the component for it left
  // recommended coverage barely moving the number (2/8 filled still scored 80).
  const requiredShare = w * 0.25;
  const recommendedShare = w - requiredShare;

  if (a.requiredMissing.length) {
    return {
      ...base,
      earned: 0,
      status: "fix",
      blocking: true,
      detail: `${a.requiredMissing.length} required specific(s) missing: ${
        a.requiredMissing.slice(0, 3).join(", ")
      }`,
    };
  }
  // A category with no recommended aspects is not a failing listing — award the
  // recommended share rather than punishing the seller for eBay's taxonomy.
  const ratio = a.recommendedTotal > 0 ? a.recommendedFilled / a.recommendedTotal : 1;
  const earned = clamp(requiredShare + recommendedShare * ratio, 0, w);
  const pct = Math.round(ratio * 100);
  return {
    ...base,
    earned,
    status: ratio >= 0.999 ? "ok" : ratio >= 0.6 ? "warn" : "fix",
    detail: a.recommendedTotal > 0
      ? `${a.recommendedFilled}/${a.recommendedTotal} recommended specifics filled (${pct}%).`
      : "All required specifics filled; this category recommends none.",
  };
}

function scorePhotos(p: QualityScoreInput["photos"]): QualityComponent {
  const w = QUALITY_WEIGHTS.photos;
  const base = { key: "photos", label: "Photos", weight: w, fixSurface: "composer.photos" };
  if (p.count <= 0) {
    return { ...base, earned: 0, status: "fix", blocking: true, detail: "No photos." };
  }
  if (p.blockers.length) {
    return { ...base, earned: 0, status: "fix", blocking: true, detail: p.blockers[0] };
  }
  // Annotated: QUALITY_WEIGHTS is `as const`, so `w` is a literal type and an
  // unannotated `let` would narrow to it and reject the clamp below.
  let earned: number = w;
  const notes: string[] = [];
  if (p.warnings.length) {
    earned -= Math.min(w * 0.5, p.warnings.length * (w * 0.2));
    notes.push(p.warnings[0]);
  }
  // The hero-type nudge is the search thumbnail (§6, biggest CTR lever).
  if (p.nudge) {
    earned -= w * 0.2;
    notes.push(p.nudge);
  }
  earned = clamp(earned, 0, w);
  return {
    ...base,
    earned,
    status: earned >= w ? "ok" : earned >= w * 0.6 ? "warn" : "fix",
    detail: notes.length ? notes.join(" ") : `${p.count} photo(s), standards met.`,
  };
}

function scoreCategory(c: QualityScoreInput["category"]): QualityComponent {
  const w = QUALITY_WEIGHTS.category;
  const base = { key: "category", label: "Category", weight: w, fixSurface: "composer.category" };
  // We could not verify the category — say so rather than guess in either
  // direction (see the unknown-signal rule in the header).
  if (c.leafStatus === "unverified") {
    return { ...base, earned: 0, status: "unknown", detail: "Category not verified yet." };
  }
  if (c.leafStatus === "not_found") {
    return { ...base, earned: 0, status: "fix", blocking: true, detail: "Category not found on eBay." };
  }
  if (c.leafStatus === "non_leaf") {
    // eBay only lists into leaf categories; a non-leaf cannot rank at all.
    return { ...base, earned: 0, status: "fix", blocking: true, detail: "Not a leaf category — pick a subcategory." };
  }
  // Leaf confirmed. Agreement with eBay's own top suggestion is the only
  // confidence signal available (the Taxonomy API returns no score).
  if (c.matchesSuggestion === null) {
    return { ...base, earned: w * 0.8, status: "ok", detail: "Leaf category." };
  }
  return c.matchesSuggestion
    ? { ...base, earned: w, status: "ok", detail: "Leaf category, matches eBay's suggestion." }
    : {
      ...base,
      earned: w * 0.6,
      status: "warn",
      detail: "Leaf category, but eBay suggests a different one for this item.",
    };
}

function scoreCondition(c: QualityScoreInput["condition"]): QualityComponent {
  const w = QUALITY_WEIGHTS.condition;
  const base = {
    key: "condition",
    label: "Condition",
    weight: w,
    fixSurface: "composer.condition",
  };
  if (c.consistent === null) {
    return { ...base, earned: 0, status: "unknown", detail: "No condition resolved yet." };
  }
  if (!c.consistent) {
    return {
      ...base,
      earned: w * 0.4,
      status: "warn",
      detail: c.warnings[0] ?? "Condition description doesn't match the selected tier.",
    };
  }
  return { ...base, earned: w, status: "ok", detail: "Condition tier and description agree." };
}

function scoreFulfillment(f: FulfillmentSignals): QualityComponent {
  const w = QUALITY_WEIGHTS.fulfillment;
  const base = {
    key: "fulfillment",
    label: "Shipping & returns",
    weight: w,
    fixSurface: "settings.businessPolicies",
  };
  // All three unreadable ⇒ no synced business policy. Unknown, not zero.
  if (f.returnsAccepted === null && f.handlingDays === null && f.freeShipping === null) {
    return { ...base, earned: 0, status: "unknown", detail: "Business policies not synced." };
  }
  // Each of the three is an eBay-CONFIRMED Best Match factor (§4), weighted
  // equally — the playbook ranks them together and gives no order among them.
  const third = w / 3;
  let earned = 0;
  const missing: string[] = [];
  if (f.returnsAccepted === true) earned += third;
  else if (f.returnsAccepted === false) missing.push("returns not accepted");
  else earned += third; // unknown sub-signal: don't penalise
  if (f.handlingDays !== null && f.handlingDays <= 1) earned += third;
  else if (f.handlingDays !== null) missing.push(`${f.handlingDays}-day handling`);
  else earned += third;
  if (f.freeShipping === true) earned += third;
  else if (f.freeShipping === false) missing.push("no free shipping option");
  else earned += third;

  earned = clamp(earned, 0, w);
  return {
    ...base,
    earned,
    status: missing.length === 0 ? "ok" : missing.length === 1 ? "warn" : "fix",
    detail: missing.length ? `Weaker on: ${missing.join(", ")}.` : "Returns, fast handling, free shipping.",
  };
}

/**
 * Compute the 0–100 Listing Quality Score and its breakdown.
 * Pure: every input is supplied by the caller (assemblePublishContext already
 * computes all of it in one pass).
 */
export function computeListingQualityScore(input: QualityScoreInput): ListingQualityScore {
  const components: QualityComponent[] = [
    scoreAspects(input.aspects),
    scorePhotos(input.photos),
    scoreTitle(input.title),
    scoreCategory(input.category),
    scoreFulfillment(input.fulfillment),
    scoreCondition(input.condition),
  ];

  const counted = components.filter((c) => c.status !== "unknown");
  const weightCounted = counted.reduce((n, c) => n + c.weight, 0);
  const earned = counted.reduce((n, c) => n + c.earned, 0);
  // No readable signal at all ⇒ 0 with weightCounted 0, so the UI can say
  // "not enough data" instead of showing a confident zero.
  const raw = weightCounted > 0 ? Math.round((earned / weightCounted) * 100) : 0;

  // A listing that cannot publish cannot rank. Cap it, so it sorts with the
  // wreckage rather than mid-pile — see BLOCKED_SCORE_CEILING.
  const blocking = components.filter((c) => c.blocking);
  const blocked = blocking.length > 0;
  const score = blocked ? Math.min(raw, BLOCKED_SCORE_CEILING) : raw;

  const topFixes = counted
    .map((c) => ({
      key: c.key,
      label: c.label,
      pointsAvailable: Math.round(((c.weight - c.earned) / (weightCounted || 1)) * 100),
      fixSurface: c.fixSurface,
    }))
    .filter((f) => f.pointsAvailable > 0)
    .sort((a, b) => b.pointsAvailable - a.pointsAvailable || a.key.localeCompare(b.key));

  return {
    score,
    components,
    weightCounted,
    topFixes,
    blocked,
    blockingReasons: blocking.map((c) => c.detail),
  };
}
