// US-2770: fill the optional item specifics the visual matches already answered.
//
// A seller resolving a category gets a list of optional aspects and fills
// approximately none of them, because typing twenty fields to become slightly
// more findable is a bad trade for one garment. The visual matches have already
// declared most of them - Department, Type, Style, Material, Pattern - and
// US-2766 computes a consensus over exactly those.
//
// WHAT THIS IS NOT. It is not an aspect writer. Nothing here reaches
// inventory_items.ebay_aspects, which is the column that becomes the published
// listing and is therefore seller-declared fact. These land in the SUGGESTIONS
// block, the same place the model's own aspect suggestions land, where a seller
// confirms them. The distinction is the identityIsAuthoritative posture from
// scout-identify.ts: a visual match is a different physical garment that happens
// to look like this one, and it never gets to assert anything on the seller's
// behalf.
//
// Three refusals, each for its own reason:
//   - an aspect the category does not expose: eBay rejects unknown aspect names
//     at publish, and a suggestion the seller cannot accept is worse than none;
//   - a SELECTION_ONLY aspect whose value is not in the allowed list: same,
//     rejected at publish;
//   - a value over 65 characters: the limit that produced the stuck offers in
//     vault/30-platform/ebay-aspect-value-limit.md.
//
// The last one REFUSES rather than truncating, which is a deliberate departure
// from how the model's own values are handled. Truncating "Long Sleeve
// Performance Half Zip Pullover Sweatshirt Top" to fit produces a value the
// seller never chose, off a garment that is not theirs. A gap is honest; a
// mangled guess is not.

import type { EbayAspectSpec } from "./ai-extract.ts";
import type { AspectValueSuggestion } from "./ai-extract.ts";
import { EBAY_ASPECT_VALUE_MAX_LEN } from "./ebay-client.ts";
import type { VisualAspectEvidence } from "./visual-aspect-consensus.ts";

/**
 * Provenance marker. Sits alongside RESEARCH_SOURCE and LEARNED_SOURCE so a
 * reader of a suggestion can always tell which machine produced it - and so the
 * UI can badge this one as needing confirmation.
 */
export const VISUAL_CONSENSUS_SOURCE = "visual_consensus";

/**
 * Confidence ceiling for a visually-derived aspect.
 *
 * Capped rather than computed from support alone, for the reason
 * EVIDENCE_PRECEDENCE exists: forty listings agreeing is still forty listings
 * that could not see the tag. A high number here would let a visual value
 * outrank something read off the garment, which is the exact inversion US-2767
 * was written to stop.
 */
export const VISUAL_ASPECT_CONFIDENCE_CAP = 0.55;

/** Minimum listings that must declare a value before it is worth offering. */
export const MIN_ASPECT_SUPPORT = 2;

export interface PrefillArgs {
  /** Per-aspect consensus from US-2766. */
  evidence: VisualAspectEvidence | null;
  /** What this category actually exposes, from getItemAspectsForCategory. */
  specs: readonly EbayAspectSpec[];
  /** Aspects already set - by the seller, or by an earlier run. Never touched. */
  existing: Readonly<Record<string, string[]>>;
  /** The model's own aspect suggestions. These WIN; this only fills gaps. */
  modelSuggestions?: Readonly<Record<string, AspectValueSuggestion>>;
}

export type PrefillSkipReason =
  | "no_consensus"
  | "below_min_support"
  | "not_exposed_by_category"
  | "not_an_allowed_value"
  | "too_long"
  | "already_set"
  | "model_answered";

export interface PrefillResult {
  /** Keyed by the CATEGORY'S spelling of the aspect name, not the match's. */
  suggestions: Record<string, AspectValueSuggestion>;
  /**
   * Why each candidate was not offered.
   *
   * Recorded rather than dropped for the same reason US-2764 keeps a losing
   * category vote: "no suggestion" and "a suggestion we threw away" look
   * identical afterwards, and only one of them means this is not working.
   */
  skipped: Array<{ aspect: string; value: string | null; reason: PrefillSkipReason }>;
}

/** The category's own spelling wins, so the aspect name matches at publish. */
function findSpec(
  specs: readonly EbayAspectSpec[],
  name: string,
): EbayAspectSpec | null {
  const want = name.trim().toLowerCase();
  for (const s of specs) {
    if (s.name.trim().toLowerCase() === want) return s;
  }
  return null;
}

function hasValue(map: Readonly<Record<string, string[]>>, name: string): boolean {
  const want = name.trim().toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.trim().toLowerCase() === want) return Array.isArray(v) && v.length > 0;
  }
  return false;
}

function modelAnswered(
  map: Readonly<Record<string, AspectValueSuggestion>> | undefined,
  name: string,
): boolean {
  if (!map) return false;
  const want = name.trim().toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.trim().toLowerCase() === want) {
      return Array.isArray(v?.values) && v.values.length > 0;
    }
  }
  return false;
}

/**
 * Pure. No network, no clock, no database - so every rule above is a unit test
 * rather than an integration one.
 */
export function visualAspectPrefill(args: PrefillArgs): PrefillResult {
  const { evidence, specs, existing, modelSuggestions } = args;
  const suggestions: Record<string, AspectValueSuggestion> = {};
  const skipped: PrefillResult["skipped"] = [];
  if (!evidence) return { suggestions, skipped };

  for (const [aspectName, consensus] of Object.entries(evidence.aspects)) {
    if (!consensus) continue;
    const value = consensus.value;

    if (value === null) {
      skipped.push({ aspect: aspectName, value: null, reason: "no_consensus" });
      continue;
    }
    if (consensus.support < MIN_ASPECT_SUPPORT) {
      skipped.push({ aspect: aspectName, value, reason: "below_min_support" });
      continue;
    }

    const spec = findSpec(specs, aspectName);
    if (!spec) {
      skipped.push({ aspect: aspectName, value, reason: "not_exposed_by_category" });
      continue;
    }
    // The category's spelling from here on: "Product Line" and "product line"
    // are the same aspect to us and two different ones to eBay.
    const key = spec.name;

    if (hasValue(existing, key)) {
      skipped.push({ aspect: key, value, reason: "already_set" });
      continue;
    }
    if (modelAnswered(modelSuggestions, key)) {
      // The model looked at the actual garment. This looked at listings that
      // resemble it. Precedence is not close.
      skipped.push({ aspect: key, value, reason: "model_answered" });
      continue;
    }
    if (value.length > EBAY_ASPECT_VALUE_MAX_LEN) {
      skipped.push({ aspect: key, value, reason: "too_long" });
      continue;
    }
    if (spec.mode === "SELECTION_ONLY") {
      const allowed = spec.allowedValues ?? [];
      const ok = allowed.some(
        (a) => a.trim().toLowerCase() === value.trim().toLowerCase(),
      );
      if (!ok) {
        skipped.push({ aspect: key, value, reason: "not_an_allowed_value" });
        continue;
      }
    }

    suggestions[key] = {
      values: [value],
      confidence: Math.min(
        VISUAL_ASPECT_CONFIDENCE_CAP,
        consensus.declared > 0 ? consensus.support / consensus.declared : 0,
      ),
      source: VISUAL_CONSENSUS_SOURCE,
    };
  }

  return { suggestions, skipped };
}
