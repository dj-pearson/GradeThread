// US-2705: the evidence plan, and the verdict that decides whether there is one.
//
// Three outcomes, and only one of them is an argument:
//
//   contradicted — the report documented the flaw AND the listing disclosed it.
//                  Worth fighting, and the plan says exactly where and when.
//   supported    — the report documented the flaw and the listing did NOT say
//                  so. The buyer is right. We refuse to assemble a pack.
//   not_covered  — the report has nothing on it. No argument is manufactured.
//
// THE REFUSAL IS THE POINT, not a safety rail bolted on. Handing eBay a signed
// document proving our own user sold an undisclosed flaw is the failure this
// epic must not ship, and it is exactly what an "always produce a defence"
// design would do. See the epic's standing safety constraints (US-2703 AC4/AC5).
//
// PURE. Grade report in, snapshot in, match in, plan out. No supabase client, no
// fetch, no clock — mirrors the lib/cross-listing-sale.ts split, and it is what
// lets the labelled fixture set be the gate rather than a spot check.

import {
  type CandidateMatch,
  MATCH_MIN_CONFIDENCE,
  type ReportedDefect,
  surviveMatches,
} from "./complaint-match.ts";

export type DisputeVerdict = "contradicted" | "supported" | "not_covered";

/** What GradeThread published, as recorded by US-2704. */
export interface PublicationSnapshot {
  description: string | null;
  aspects: Record<string, string[]> | null;
  publishedAt: string;
  lastConfirmedAt: string;
}

/** One thing the pack will assert, and the report line that backs it. */
export interface Citation {
  defectIndex: number;
  defectType: string;
  location: string;
  severity: string;
  /** The report's own sentence. Quoted, never paraphrased. */
  reportText: string;
  /** The disclosure sentence found in the published listing. */
  disclosedIn: "description" | "aspects";
  disclosureQuote: string;
}

export interface EvidencePlan {
  verdict: DisputeVerdict;
  citations: Citation[];
  /** Report photo indexes worth attaching, in report order. */
  photoDefectIndexes: number[];
  /** True only for `contradicted`. */
  mayAutoAssemble: boolean;
  /** Plain language, for the seller. Never sent to the marketplace. */
  reason: string;
}

export interface EvidenceInput {
  defects: readonly ReportedDefect[];
  snapshot: PublicationSnapshot | null;
  matches: readonly CandidateMatch[];
  minConfidence?: number;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** The sentence in a block of text that mentions a term, or null. */
function sentenceMentioning(text: string, terms: readonly string[]): string | null {
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/);
  for (const sentence of sentences) {
    const flat = normalize(sentence);
    if (terms.some((t) => t && flat.includes(normalize(t)))) {
      const trimmed = sentence.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/**
 * Did the published listing actually disclose this defect?
 *
 * Reads the SNAPSHOT, never the current listing. What the seller published is
 * what they can be held to; what the listing says today may have been edited by
 * anyone, including them, after the sale.
 *
 * The terms are the report's own words plus the defect's location, because a
 * disclosure written by a seller says "small stain on the left cuff" and not
 * "stain (minor, left cuff)". A defect type alone is too weak: "no holes" would
 * match `hole_puncture` and read as a disclosure of the opposite.
 */
export function findDisclosure(
  defect: ReportedDefect,
  snapshot: PublicationSnapshot | null,
): { where: "description" | "aspects"; quote: string } | null {
  if (!snapshot) return null;
  const terms = [defect.defect_type?.split("_")[0], defect.location]
    .filter((t): t is string => !!t && t.length > 2);
  if (terms.length === 0) return null;

  if (snapshot.description) {
    // BOTH terms, not either. A description mentioning "cuff" for a measurement
    // and "stain" in a boilerplate "no stains" line would otherwise read as a
    // disclosure of a stain on the cuff.
    const hit = sentenceMentioning(snapshot.description, [terms[0]!]);
    if (hit && terms.every((t) => normalize(hit).includes(normalize(t)))) {
      return { where: "description", quote: hit };
    }
  }

  if (snapshot.aspects) {
    for (const [key, values] of Object.entries(snapshot.aspects)) {
      for (const value of values) {
        const flat = normalize(`${key} ${value}`);
        if (terms.every((t) => flat.includes(normalize(t)))) {
          return { where: "aspects", quote: `${key}: ${value}` };
        }
      }
    }
  }
  return null;
}

/**
 * Build the plan.
 *
 * ORDER OF DECISION IS THE CONTRACT. Matches are filtered against the real
 * defect list FIRST, so a citation naming a defect that is not in the report
 * cannot reach the verdict logic at all — dropped, never softened into a weaker
 * claim (AC5). Only what survives is asked the disclosure question.
 */
export function buildEvidencePlan(input: EvidenceInput): EvidencePlan {
  const min = input.minConfidence ?? MATCH_MIN_CONFIDENCE;
  const survived = surviveMatches(input.matches, input.defects, min);

  // Nothing in the report answers this complaint. Say so, and say what to do.
  // An argument built here would be built out of nothing.
  if (survived.length === 0) {
    return {
      verdict: "not_covered",
      citations: [],
      photoDefectIndexes: [],
      mayAutoAssemble: false,
      reason:
        "The grade report does not document what the buyer is describing. " +
        "There is no evidence to submit, and a response that argues anyway is " +
        "arguing from nothing — consider refunding.",
    };
  }

  const citations: Citation[] = [];
  const undisclosed: ReportedDefect[] = [];

  for (const match of survived) {
    const defect = input.defects[match.defectIndex]!;
    const disclosure = findDisclosure(defect, input.snapshot);
    if (!disclosure) {
      undisclosed.push(defect);
      continue;
    }
    citations.push({
      defectIndex: match.defectIndex,
      defectType: defect.defect_type ?? "other",
      location: defect.location,
      severity: defect.severity,
      reportText: defect.issue,
      disclosedIn: disclosure.where,
      disclosureQuote: disclosure.quote,
    });
  }

  // THE REFUSAL. The report documents the flaw and the listing did not disclose
  // it, so the buyer is describing something real that they were not told about.
  // Checked BEFORE the contradicted branch on purpose: a dispute where one flaw
  // was disclosed and another was not is not half a win, and assembling the
  // half that suits us would be selecting evidence.
  if (undisclosed.length > 0) {
    const names = undisclosed
      .map((d) => `${d.severity} ${d.defect_type ?? "issue"} (${d.location})`)
      .join(", ");
    return {
      verdict: "supported",
      citations: [],
      photoDefectIndexes: [],
      mayAutoAssemble: false,
      reason:
        `Your grade report documents ${names}, and the listing GradeThread ` +
        "published did not disclose it. The buyer is describing something the " +
        "report agrees is there. Fighting this loses and costs you shipping " +
        "both ways — consider refunding.",
    };
  }

  return {
    verdict: "contradicted",
    citations,
    photoDefectIndexes: citations.map((c) => c.defectIndex),
    mayAutoAssemble: true,
    reason:
      `The listing disclosed ${citations.length === 1 ? "this flaw" : "these flaws"} ` +
      "before the sale, and the grade report dated it. That is what the pack " +
      "submits. eBay decides the case.",
  };
}
