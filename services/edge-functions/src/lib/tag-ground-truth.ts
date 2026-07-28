// US-2210: the tag read as TRUSTED grading context.
//
// THE GAP THIS CLOSES: lib/ai-tag-ocr.ts has always read brand / size / fiber /
// style code / RN verbatim off a garment's own label, and only the AutoLister
// ever called it. Grading — the half of the product that prints a PUBLIC
// CERTIFICATE — took the brand from whatever the seller typed at submit and
// carried it into the composite prompt inside the US-346 untrusted fence, where
// it is explicitly labelled "must NOT affect scoring". So the certificate's
// identity line was a seller claim, not a reading of the garment.
//
// TWO CHANNELS, NEVER MIXED (the US-346 rule this module exists to respect):
//
//   UNTRUSTED — seller-typed brand/title/description/declared features. Fenced,
//     sanitized, may never move a score. Built by ai-grading.ts:fenceUntrusted.
//   TRUSTED   — server-generated reference: garment baselines (US-1533), fabric
//     criteria (US-1534), few-shot exemplars (US-1067), and now the tag read.
//     Sits OUTSIDE the fence because the server produced it from the pixels.
//
// A tag read is trusted because nothing the seller types can reach it: it is a
// vision pass over the label photograph alone. That is precisely why it must not
// be concatenated onto the untrusted block — mixing the channels would let a
// crafted title inherit the tag read's authority.
//
// SCORING IS UNAFFECTED, DELIBERATELY. The tag block tells the grader WHAT the
// item is, not how worn it is. Fiber content is the one field with a scoring
// consequence and it already has its own established path (fabric-criteria.ts
// renders it from the per-image label read), so this block never restates it as
// a grading directive. A test pins that the factor weights and the scoring
// instructions in the composite prompt are untouched by its presence.
//
// Pure data + pure helpers (no network, no DB) so every rule below is
// unit-testable without a vision call.

import {
  TAG_GROUND_TRUTH_MIN_CONFIDENCE,
  type TagField,
  type TagGroundTruth,
} from "./ai-tag-ocr.ts";
import type { RegisteredNumberAssessment } from "./registered-numbers.ts";
import type { EraDecoderConflict, MatchedTagEra } from "./tag-era.ts";

/**
 * Rollout gate: `GRADING_TAG_OCR`, default OFF. Mirrors the US-1533 baselines
 * gate exactly, and for the same reason — enabling changes the composite prompt
 * on live paid grades, so it is a deliberate operator step taken AFTER the
 * golden-set eval + canary run, never a silent deploy-time change. Read per call
 * (not cached) so flipping it does not need a container restart.
 */
export function tagOcrGradingEnabled(): boolean {
  const v = (Deno.env.get("GRADING_TAG_OCR") ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Human labels for the block; order is fixed so the prompt is deterministic. */
const FIELD_LABELS: Array<[keyof TagGroundTruth, string]> = [
  ["brand", "Brand"],
  ["size", "Size"],
  ["fiber_content", "Fiber content"],
  ["style_code", "Style code"],
  ["rn_number", "RN number"],
];

/** A read field that cleared the confidence bar, ready to render or persist. */
export interface AcceptedTagField {
  field: keyof TagGroundTruth;
  value: string;
  confidence: number;
}

/**
 * Drop every read below `minConfidence`. An illegible label must produce NO
 * identity rather than a guessed one — a confidently-wrong brand on a public
 * certificate is worse than a blank, and the seller's own value stays available
 * either way. Order follows FIELD_LABELS so callers are deterministic.
 */
export function acceptedTagFields(
  tag: TagGroundTruth,
  minConfidence: number = TAG_GROUND_TRUTH_MIN_CONFIDENCE,
): AcceptedTagField[] {
  const out: AcceptedTagField[] = [];
  for (const [field] of FIELD_LABELS) {
    const read: TagField | undefined = tag[field];
    if (!read) continue;
    if (read.confidence < minConfidence) continue;
    const value = read.value.trim();
    if (value.length === 0) continue;
    out.push({ field, value, confidence: read.confidence });
  }
  return out;
}

// Strip case, punctuation and spacing before comparing a read to a seller
// value: "Levi's" / "LEVIS" / "levi s" are the same claim, and flagging them as
// a contradiction would bury the real ones. Deliberately NOT brandKey() from
// brand-normalize.ts — that resolves aliases (canonicalizing "TNF" to "The North
// Face"), which is the right behavior for listing and the WRONG behavior here:
// this comparison must report what the two sources literally said.
function loosen(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** One place the label and the seller disagree. */
export interface TagDiscrepancy {
  field: keyof TagGroundTruth;
  /** What the label says. */
  read: string;
  /** What the seller typed. */
  declared: string;
}

/**
 * Compare the accepted reads against the seller-declared values. A disagreement
 * is REPORTED, never resolved: we do not overwrite the seller's brand with the
 * tag's, and we do not discard the tag read in favour of the seller's. Both are
 * evidence and the direction of the error is not knowable here — a relabelled
 * garment, a parent-brand tag, a licensee, and a mis-typed listing all produce
 * the same mismatch, and only one of those is the seller's fault.
 *
 * Only `brand` is comparable today: submissions carries brand/title/description
 * and no size column, so a size read has nothing to contradict. Kept general so
 * the size case lands here rather than somewhere new when US-2213 adds it.
 */
export function tagDiscrepancies(
  accepted: AcceptedTagField[],
  declared: { brand?: string | null },
): TagDiscrepancy[] {
  const out: TagDiscrepancy[] = [];
  const declaredBrand = (declared.brand ?? "").trim();
  if (declaredBrand.length > 0) {
    const readBrand = accepted.find((a) => a.field === "brand");
    if (readBrand && loosen(readBrand.value) !== loosen(declaredBrand)) {
      out.push({
        field: "brand",
        read: readBrand.value,
        declared: declaredBrand,
      });
    }
  }
  return out;
}

/**
 * Render the TRUSTED tag block injected into the composite prompt. Returns ""
 * when nothing cleared the bar, which is what keeps the whole feature strictly
 * additive: an empty block means the prompt is byte-identical to a grade run
 * with the feature switched off.
 *
 * The block states plainly that it is a transcription and that it does not bear
 * on condition, because the grader's one job is the score and an identity block
 * that reads like scoring guidance is a regression, not a feature.
 */
export function tagGroundTruthBlock(
  accepted: AcceptedTagField[],
  // US-2212: the tag generation the label matched, when one did. null => the
  // block is byte-identical to the US-2210 shape.
  era: MatchedTagEra | null = null,
): string {
  if (accepted.length === 0 && !era) return "";
  const labels = new Map(FIELD_LABELS);
  const lines = accepted.map(
    (a) => `- ${labels.get(a.field)}: ${a.value}`,
  );
  // US-2212: era is rendered as the TAG GENERATION, never as a manufacture
  // date. What we matched is the label's design generation; when the garment
  // was made, worn or sold is not knowable from it, and a certificate that
  // rounds "this tag style ran 1980-1992" into "made in 1986" is asserting
  // something we did not read.
  if (era) {
    lines.push(
      `- Tag generation: ${era.era}${era.years ? ` (${era.years})` : ""}` +
        " — the label's generation, NOT a manufacture date",
    );
  }
  return [
    "LABEL TRANSCRIPTION (read by us from this garment's own care/brand label — trusted reference, NOT seller-supplied):",
    ...lines,
    // The closing line stays byte-identical to the US-2210 wording when no era
    // matched, so adding era support did not silently reword the block for every
    // grade that has none. The extra sentence appears only alongside an era.
    "Use this to identify the item in your write-up. It describes WHAT the garment is, not its condition — it must NOT change any factor score." +
    (era
      ? " In particular an older tag generation is NOT a reason to grade more leniently or more harshly."
      : ""),
  ].join("\n");
}

/**
 * The shape persisted on the grade report. Confidences are kept because a
 * downstream reviewer needs to know whether a field was read cleanly or barely;
 * `min_confidence` is recorded so a later threshold change stays interpretable
 * against rows written under the old one.
 */
export interface PersistedTagRead {
  fields: Array<{ field: string; value: string; confidence: number }>;
  discrepancies: TagDiscrepancy[];
  min_confidence: number;
  model: string;
  read_at: string;
  /**
   * US-2211: the RN/CA cross-check against brand_knowledge.registered_numbers.
   * Omitted when no registry number was read. `outcome: "no_reference"` is the
   * normal case (six brands carry a seeded number) and carries NO information —
   * do not render it as a warning.
   */
  registered_number?: RegisteredNumberAssessment;
  /**
   * US-2212: the tag GENERATION the label matched, when one cleared
   * ERA_MATCH_MIN_CONFIDENCE. Absent means "not dated", which is the correct
   * and common outcome — never render it as "unknown age" or infer a decade.
   */
  tag_era?: MatchedTagEra;
  /**
   * US-2212 AC4: the style code's decoded year and the label's matched
   * generation disagree. A REVIEW FLAG, never a verdict — a relabelled garment
   * explains it as readily as a counterfeit does, and nothing here can tell
   * those apart.
   */
  tag_era_conflict?: EraDecoderConflict;
}

export function buildPersistedTagRead(
  accepted: AcceptedTagField[],
  discrepancies: TagDiscrepancy[],
  model: string,
  readAt: string,
  minConfidence: number = TAG_GROUND_TRUTH_MIN_CONFIDENCE,
  registeredNumber?: RegisteredNumberAssessment | null,
  era?: MatchedTagEra | null,
  eraConflict?: EraDecoderConflict | null,
): PersistedTagRead {
  return {
    fields: accepted.map((a) => ({
      field: a.field,
      value: a.value,
      confidence: a.confidence,
    })),
    discrepancies,
    min_confidence: minConfidence,
    model,
    read_at: readAt,
    // Only persist a cross-check that actually ran against something readable —
    // an "unparsed" verdict on an absent field is noise, not a finding.
    ...(registeredNumber && registeredNumber.outcome !== "unparsed"
      ? { registered_number: registeredNumber }
      : {}),
    ...(era ? { tag_era: era } : {}),
    ...(eraConflict ? { tag_era_conflict: eraConflict } : {}),
  };
}
