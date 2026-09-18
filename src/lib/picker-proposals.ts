import { MARKETPLACE_SPECS } from "@/lib/marketplace-specs";

// US-3210 AC2: what the extension should PRE-SELECT in Poshmark's and Mercari's
// pickers, from the item the seller already filled in.
//
// The complaint this exists for is specific. extension-unified fills every TEXT
// field and deliberately leaves every picker blank, so a seller who has already
// entered brand, size, colour and condition once retypes four of them per
// platform. Seven independent forum sources give that as the reason a
// crosslister "defeats the purpose".
//
// PURE ON PURPOSE. No DOM, no network, no platform option lists. It proposes a
// VALUE and a confidence; matching that value against whatever the live form is
// showing is the lister's job (AC3), and reporting what happened is the
// writeback's (AC4). Keeping those apart is what lets this be unit-tested
// without a browser and without a captured fixture.
//
// `none` IS A RESULT, NOT A FAILURE. A picker this cannot map returns none with
// the reason, and the lister leaves it blank. The alternative -- guessing a
// category so the field looks handled -- is worse than blank: a wrong category
// mis-files the listing where nobody browsing will see it, and the seller has
// no reason to look at a field that appears filled.

/**
 * How much the proposal should be trusted.
 *
 * - `exact`  the value is derived from something the seller or the grader
 *            stated, and there is one right answer.
 * - `likely` derived, but the platform may spell it differently or the value
 *            is a judgement call at a band edge.
 * - `none`   not mappable. `value` is null and `why` says what is missing.
 */
export type PickerConfidence = "exact" | "likely" | "none";

export interface PickerProposal {
  /** The picker's field key, as marketplace-specs.ts names it. */
  field: string;
  /** Null whenever confidence is "none". */
  value: string | null;
  confidence: PickerConfidence;
  /** Why this value, or why there is none. Shown to the seller and logged. */
  why: string;
}

export interface PickerSource {
  /** 1.0-10.0. Null when the item has not been graded. */
  gradeValue?: number | null;
  /** The tier label, e.g. "NWT". Read for its NWT claim even when grade is null. */
  gradeTier?: string | null;
  size?: string | null;
  color?: string | null;
  /** eBay's leaf-to-root path, which is the only taxonomy this repo holds. */
  ebayCategoryPath?: readonly string[] | null;
}

/** Trimmed, or null. Treats a whitespace-only field as absent. */
function clean(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length > 0 ? s : null;
}

const NWT_TIER = /\bNWT\b/i;

/** True when the item is claimed new-with-tags, by tier or by grade. */
function isNwt(src: PickerSource): boolean {
  if (NWT_TIER.test(src.gradeTier ?? "")) return true;
  return (src.gradeValue ?? 0) >= 9.75;
}

/**
 * Mercari's five-step condition, from the grade.
 *
 * The bands mirror mapEbayCondition in src/lib/ebay-prefill.ts rather than
 * being invented: the same grade must not describe an item as Like new on one
 * platform and Good on another, and a seller comparing their own two listings
 * is exactly who would notice.
 */
function mercariCondition(src: PickerSource): PickerProposal {
  const grade = src.gradeValue;
  if (isNwt(src)) {
    return { field: "condition", value: "New", confidence: "exact", why: "graded new with tags" };
  }
  if (grade == null) {
    return {
      field: "condition",
      value: null,
      confidence: "none",
      why: "the item has no grade, and condition is required on Mercari",
    };
  }
  // Band edges are a judgement call, so everything below New is `likely`. The
  // seller confirms; the point is that they confirm rather than choose.
  if (grade >= 9.0) return { field: "condition", value: "Like new", confidence: "likely", why: `grade ${grade}` };
  // eBay splits 7.5 and 6.0 into two conditions; Mercari has five steps and
  // both collapse to Good. Written as ONE branch rather than two identical
  // ones, because a dead branch reads as an unfinished mapping.
  if (grade >= 6.0) return { field: "condition", value: "Good", confidence: "likely", why: `grade ${grade}` };
  if (grade >= 4.5) return { field: "condition", value: "Fair", confidence: "likely", why: `grade ${grade}` };
  return { field: "condition", value: "Poor", confidence: "likely", why: `grade ${grade}` };
}

/**
 * Poshmark's only structured condition flag is a New-With-Tags toggle.
 *
 * FALSE IS A REAL ANSWER and it is exact. A graded item that is not NWT is
 * definitely not NWT, so the toggle can be set with confidence rather than
 * left for the seller. Only an ungraded item with no tier is unknowable.
 */
function poshmarkNwt(src: PickerSource): PickerProposal {
  if (isNwt(src)) {
    return { field: "nwt", value: "true", confidence: "exact", why: "graded new with tags" };
  }
  if (src.gradeValue == null && clean(src.gradeTier) == null) {
    return {
      field: "nwt",
      value: null,
      confidence: "none",
      why: "no grade and no tier, so new-with-tags is unknown",
    };
  }
  return { field: "nwt", value: "false", confidence: "exact", why: "graded, and not new with tags" };
}

/**
 * Sizes the platforms spell the same way as the item does.
 *
 * Anything outside this set still gets proposed, at `likely`, because the
 * lister matches against the live option list and reports a miss. Refusing to
 * propose "32x34" because it is not in a hardcoded set would be this module
 * guessing about a form it cannot see.
 */
const STANDARD_SIZES = new Set([
  "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL",
  "0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20",
  "OS", "ONE SIZE",
]);

function sizeProposal(src: PickerSource): PickerProposal {
  const size = clean(src.size);
  if (!size) {
    return { field: "size", value: null, confidence: "none", why: "the item has no size recorded" };
  }
  const exact = STANDARD_SIZES.has(size.toUpperCase());
  return {
    field: "size",
    value: size,
    confidence: exact ? "exact" : "likely",
    why: exact ? "a standard size both platforms list" : `"${size}" may be spelled differently on the form`,
  };
}

function colorProposal(src: PickerSource): PickerProposal {
  const color = clean(src.color);
  if (!color) {
    return { field: "color", value: null, confidence: "none", why: "the item has no colour recorded" };
  }
  // Poshmark takes up to two colours and the item carries one string, which may
  // itself be a brand colourway ("Deep Ocean"). Proposing it at `likely` lets
  // the lister try an exact option match and report a miss, which is how the
  // colourway case gets measured rather than assumed.
  return { field: "color", value: color, confidence: "likely", why: `item colour "${color}"` };
}

/**
 * Category, and it is always `none` today.
 *
 * Both platforms carry their own tree (`usesOwnTaxonomy` in
 * marketplace-specs.ts) and this repo holds no map from eBay's path to either
 * one. Returning a guess here is the single most expensive thing this module
 * could do: category is required on both, and a wrong one mis-files the listing
 * where nobody browsing will find it, while looking handled.
 *
 * The eBay path is accepted and echoed in `why` rather than ignored, so the
 * writeback records what the mapping WOULD have had to work from. AC6's
 * captured option lists are what turns this into a real mapping.
 */
function categoryProposal(src: PickerSource): PickerProposal {
  const path = (src.ebayCategoryPath ?? []).filter((p) => clean(p) !== null);
  return {
    field: "category",
    value: null,
    confidence: "none",
    why: path.length
      ? `no eBay-to-platform category map exists yet; eBay path was ${path.join(" > ")}`
      : "no eBay-to-platform category map exists yet, and the item has no eBay category either",
  };
}

const BUILDERS: Record<string, (src: PickerSource) => PickerProposal> = {
  category: categoryProposal,
  size: sizeProposal,
  color: colorProposal,
  nwt: poshmarkNwt,
  condition: mercariCondition,
};

/** The platforms this mapper covers. Others have no picker contract yet. */
export type PickerPlatform = "poshmark" | "mercari";

/**
 * One proposal per picker the platform declares as manual.
 *
 * Driven from `manualFields` in marketplace-specs.ts rather than from a list
 * here, so a picker added there cannot be silently skipped: an unknown field
 * comes back as `none` naming itself, which is visible, instead of absent,
 * which is not.
 */
export function proposePickers(
  platform: PickerPlatform,
  src: PickerSource,
): PickerProposal[] {
  const fields = MARKETPLACE_SPECS[platform]?.manualFields ?? [];
  return fields.map((field) => {
    const build = BUILDERS[field];
    if (!build) {
      return {
        field,
        value: null,
        confidence: "none" as const,
        why: `${field} is declared manual for ${platform} and this mapper has no rule for it`,
      };
    }
    return build(src);
  });
}
