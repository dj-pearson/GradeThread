// 2026-09-02: what the AutoLister does with the RN the tag OCR reads.
//
// Until now the number reached the prompt as knownFields.rn_number and was
// then dropped: no registry check, no sighting, nothing stored. The grading
// pipeline has done the cross-check since US-2211; this is the same rule on
// the listing side, and the same three refusals
// (vault/40-growth/rn-lookup.md):
//   - an RN names the COMPANY, never the brand, so it corroborates or lowers
//     confidence and never writes `brand`;
//   - `no_reference` is the normal case and is not a negative signal;
//   - a contradiction is review, never a conclusion.
//
// Pure. The caller does the two side effects (fieldConfidence cap, sighting).

import type { RegisteredNumberAssessment } from "./registered-numbers.ts";

/** Below LISTING_REVIEW_CONFIDENCE (0.7), so the draft lands in review. */
export const RN_CONTRADICTION_BRAND_CONFIDENCE = 0.5;

export interface ListingRnPlan {
  outcome: RegisteredNumberAssessment["outcome"];
  note: string;
  /** Fill-only attribute writes. */
  attributes: Record<string, string>;
  /** brand confidence to apply (min with existing) when the RN contradicts. */
  brandConfidenceCap: number | null;
  /** True when the number should be recorded as a sighting. */
  recordSighting: boolean;
}

function has(
  attrs: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  const v = attrs?.[key];
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return v != null;
}

export function planListingRegisteredNumber(args: {
  rn: string | null;
  declaredBrand: string | null;
  existingAttributes: Record<string, unknown> | null | undefined;
  assessment: RegisteredNumberAssessment;
}): ListingRnPlan {
  const a = args.assessment;
  const base: ListingRnPlan = {
    outcome: a.outcome,
    note: a.note,
    attributes: {},
    brandConfidenceCap: null,
    recordSighting: false,
  };
  const rn = (args.rn ?? "").trim();
  if (a.outcome === "unparsed" || rn === "") return base;

  const attributes: Record<string, string> = {};
  if (!has(args.existingAttributes, "rn")) attributes.rn = rn;
  if (a.registrant && !has(args.existingAttributes, "rn_registrant")) {
    attributes.rn_registrant = a.registrant;
  }
  return {
    ...base,
    attributes,
    brandConfidenceCap: a.outcome === "contradicts"
      ? RN_CONTRADICTION_BRAND_CONFIDENCE
      : null,
    recordSighting: a.outcome === "no_reference",
  };
}
