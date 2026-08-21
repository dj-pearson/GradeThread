// US-2705: what the buyer is complaining about, against what the report found.
//
// A buyer writes "there is a mark on the sleeve". The report says
// { defect_type: "stain", location: "left cuff", severity: "minor" }. Deciding
// that those are the same thing is semantic, which is why the epic's design puts
// an AI matcher in front of this file.
//
// THIS FILE IS NOT THAT MATCHER. It is the deterministic layer the matcher's
// output has to survive, plus a keyword pass good enough to stand alone when no
// model runs. The model proposes; code decides what survives. Same split as
// lib/grading-pipeline.ts, and for the same reason: a citation is a claim made
// under our signature to a marketplace that is deciding whether to take the
// seller's money back.
//
// PURE. No supabase client, no fetch, no clock. Everything here is a function of
// its arguments, which is what lets the fixture set in
// complaint-match_test.ts be the real gate.

import type { DefectType, SizeBucket } from "./defect-weighting.ts";

/** The subset of a grade report's DetectedIssue this layer reasons about. */
export interface ReportedDefect {
  /** The model's own sentence, e.g. "Small stain near the left cuff". */
  issue: string;
  defect_type?: DefectType;
  severity: "minor" | "moderate" | "major";
  size_bucket?: SizeBucket;
  location: string;
  /** Manufactured distressing. Reported for transparency, never a defect. */
  is_intentional: boolean;
}

/** One proposed link between the complaint and a defect in the report. */
export interface CandidateMatch {
  /** Index into the defects array the caller passed. */
  defectIndex: number;
  /** 0..1. A model's own number, or the keyword pass's. */
  confidence: number;
  /** Why, in the matcher's words. Never shown to eBay; it is for the seller. */
  reason?: string;
}

export interface MatchResult {
  matches: CandidateMatch[];
  /** True when at least one match cleared MATCH_MIN_CONFIDENCE. */
  matched: boolean;
}

/**
 * Below this a proposed match is not a match.
 *
 * Deliberately high, and asymmetric on purpose: a missed match costs the seller
 * an argument they might have won, and a wrong one puts a defect in front of
 * eBay that the report does not document. Only the second is a lie. Mirrors
 * RESEARCH_MIN_CONFIDENCE's posture — drop rather than soften.
 */
export const MATCH_MIN_CONFIDENCE = 0.7;

/**
 * Complaint words that name a defect type.
 *
 * A buyer does not write "abrasion_thinning". This is what they DO write, and
 * it is the whole of the standalone matcher: no stemming, no fuzzy distance,
 * because a near-miss here becomes a citation and the cost of the two errors is
 * not symmetric.
 */
const COMPLAINT_VOCABULARY: Partial<Record<DefectType, readonly string[]>> = {
  stain: ["stain", "mark", "spot", "discolored patch", "dirty", "soiled"],
  hole_puncture: ["hole", "puncture", "pinhole", "burn hole"],
  rip_tear: ["rip", "ripped", "tear", "torn", "split"],
  seam_failure_unthreading: ["seam", "unstitched", "coming apart", "unravel", "unraveling"],
  pilling: ["pilling", "pills", "bobbles", "fuzzy"],
  abrasion_thinning: ["worn through", "thin", "threadbare", "abrasion", "scuff"],
  fading: ["faded", "fading", "washed out"],
  discoloration: ["discolored", "discoloured", "yellowed", "yellowing"],
  snag_pull: ["snag", "pull", "pulled thread"],
  broken_zipper: ["zipper", "zip", "broken zip"],
  broken_button: ["button", "missing button", "broken button"],
  missing_hardware: ["missing hardware", "missing snap", "missing rivet", "missing buckle"],
  stretched_misshapen: ["stretched", "misshapen", "out of shape", "saggy"],
  odor_indicator: ["smell", "smells", "odor", "odour", "musty", "smoke"],
  wrinkle_crease: ["wrinkle", "crease", "creased"],
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Words in the complaint that look like a place on a garment. */
const LOCATION_WORDS = [
  "sleeve", "cuff", "collar", "hem", "chest", "back", "front", "shoulder",
  "pocket", "waist", "knee", "seat", "armpit", "underarm", "elbow", "hood",
  "zipper", "placket", "lining", "left", "right", "inside", "interior",
];

function locationWords(text: string): string[] {
  const words = new Set(normalize(text).split(" "));
  return LOCATION_WORDS.filter((w) => words.has(w));
}

/**
 * Does the complaint name this defect type at all?
 *
 * Phrase-aware: "missing button" must match `broken_button` on the word button,
 * and `missing_hardware` only on its own phrases, so a multi-word entry is
 * tested as a phrase rather than as loose words.
 */
function mentionsType(complaint: string, type: DefectType): boolean {
  const words = COMPLAINT_VOCABULARY[type];
  if (!words) return false;
  const text = normalize(complaint);
  return words.some((w) => {
    const term = normalize(w);
    return term.includes(" ")
      ? text.includes(term)
      : new RegExp(`\\b${term}\\b`).test(text);
  });
}

/**
 * The standalone keyword matcher.
 *
 * Confidence is built from what actually agrees, not from a feeling: naming the
 * defect type is the floor, and agreeing about WHERE it is on the garment is
 * what lifts it over the bar. A complaint that names a stain when the report
 * documents a stain somewhere else entirely stays below MATCH_MIN_CONFIDENCE
 * and therefore resolves to not_covered, which is the correct answer.
 */
export function matchComplaint(
  complaint: string,
  defects: readonly ReportedDefect[],
): MatchResult {
  const matches: CandidateMatch[] = [];
  const complaintPlaces = locationWords(complaint);

  // How many real defects of each type the report documents.
  //
  // This is what decides whether a complaint with NO location is identifying
  // one defect or gesturing at several. "It smells of smoke" against a report
  // with one odor entry names that entry; the same words against a report with
  // three stains in three places name none of them, and AC4 says that resolves
  // DOWN. Counted once here rather than re-derived per defect.
  const perType = new Map<string, number>();
  for (const d of defects) {
    if (d.is_intentional || !d.defect_type) continue;
    perType.set(d.defect_type, (perType.get(d.defect_type) ?? 0) + 1);
  }

  defects.forEach((defect, defectIndex) => {
    // A manufactured design feature is not a defect and can never be the
    // subject of a contradiction. Citing distressing as a documented flaw would
    // be arguing that we sold a damaged garment.
    if (defect.is_intentional) return;

    const type = defect.defect_type;
    const namesType = type ? mentionsType(complaint, type) : false;
    // The report's own sentence is a second vocabulary: it says "stain" in
    // English even on a pre-taxonomy grade with no defect_type at all.
    const namesIssueWord = normalize(defect.issue)
      .split(" ")
      .filter((w) => w.length > 4)
      .some((w) => normalize(complaint).includes(w));

    if (!namesType && !namesIssueWord) return;

    const defectPlaces = locationWords(`${defect.location} ${defect.issue}`);
    const sharedPlace = complaintPlaces.some((p) => defectPlaces.includes(p));
    // No location in the complaint at all is NOT disagreement — a buyer often
    // writes "there is a stain" and nothing more. It is simply no evidence
    // either way, so it neither lifts nor sinks the score.
    const placeUnknown = complaintPlaces.length === 0 || defectPlaces.length === 0;

    // A buyer often writes no location at all — "it smells of smoke", "there is
    // a hole". That is not a weak match, it is a match with nothing to check
    // the location against, and the report having exactly ONE defect of that
    // type is what makes it unambiguous. Several, and the complaint identifies
    // none of them.
    const unique = namesType && perType.get(type as string) === 1;
    let confidence = namesType ? (placeUnknown && unique ? 0.7 : 0.6) : 0.45;
    if (sharedPlace) confidence += 0.25;
    else if (!placeUnknown) confidence -= 0.25;

    matches.push({
      defectIndex,
      confidence: Math.max(0, Math.min(1, confidence)),
      reason: namesType
        ? `complaint names ${type}${sharedPlace ? " in the same place" : ""}`
        : "complaint echoes the report's own wording",
    });
  });

  matches.sort((a, b) => b.confidence - a.confidence);
  return {
    matches,
    matched: matches.some((m) => m.confidence >= MATCH_MIN_CONFIDENCE),
  };
}

/**
 * Keep only the matches that clear the bar AND point at a defect that exists.
 *
 * The second half is the one that matters, and it is why this function exists
 * separately from matchComplaint: an AI matcher's output arrives here too, and
 * a model asked to find a match will invent an index, a defect type, or both.
 * An out-of-range index is dropped rather than clamped — clamping would silently
 * re-point a fabricated citation at a real defect, which is the worst available
 * outcome.
 */
export function surviveMatches(
  matches: readonly CandidateMatch[],
  defects: readonly ReportedDefect[],
  minConfidence: number = MATCH_MIN_CONFIDENCE,
): CandidateMatch[] {
  return matches.filter((m) =>
    Number.isFinite(m.confidence) &&
    m.confidence >= minConfidence &&
    Number.isInteger(m.defectIndex) &&
    m.defectIndex >= 0 &&
    m.defectIndex < defects.length &&
    !defects[m.defectIndex]!.is_intentional
  );
}
