// US-2767: handing the model eBay's visual guess WITHOUT it becoming the answer.
//
// ── The trap, stated plainly ─────────────────────────────────────────────────
// Whatever you show a model first becomes what it agrees with. The extraction
// prompt already has a block for outside information and it reads:
//
//     ALREADY KNOWN (ground truth - do not contradict, only fill gaps)
//
// Putting eBay's visual match in THAT block would end the argument before it
// started. It is not ground truth. It is a similarity match, and the measured
// failure mode is that it arrives with no expressed doubt: a teal tank with no
// brand mark anywhere in frame returned five Lululemon tanks, and the photo
// cannot tell you whether that is right
// (vault/30-platform/ebay-visual-search.md).
//
// So the candidates get their own block, with the opposite instruction, and the
// model has to say what evidence accepted each one.
//
// ── Why precedence, and not a confidence number ──────────────────────────────
// These sources are different KINDS of claim, not different amounts of one:
//
//   style code   a number printed on the size tag. Nothing to be uncertain
//                about; it either decodes or it does not.
//   tag wordmark words photographed on the garment. The seller can re-read it.
//   visual       listings that LOOK like this. Confident either way.
//   knowledge    what the model recalls about the product line.
//
// A visual match with forty supporting listings still loses to one legible tag,
// and no confidence score can express that ordering because the visual match
// would win on the number.

/** Where a candidate value came from. Ordered strongest first. */
export const EVIDENCE_PRECEDENCE = [
  "style_code",
  "tag_wordmark",
  "visual_consensus",
  "model_knowledge",
] as const;

export type EvidenceKind = (typeof EVIDENCE_PRECEDENCE)[number];

/** Lower is stronger. Used to resolve two sources claiming one field. */
export function evidenceRank(kind: EvidenceKind): number {
  return EVIDENCE_PRECEDENCE.indexOf(kind);
}

/** One thing the visual matches claim about the garment. */
export interface VisualCandidate {
  /** The field it speaks to, in our own vocabulary: "brand", "type", … */
  field: string;
  value: string;
  /** How many of the read listings declared it. */
  support: number;
  /** How many declared that field at all, so 2-of-5 reads differently to 2-of-2. */
  outOf: number;
}

export type CandidateVerdict = "accepted" | "rejected";

export interface CandidateRuling {
  field: string;
  value: string;
  verdict: CandidateVerdict;
  /** Which evidence accepted it. Required on "accepted"; see dropUnevidenced. */
  evidence: EvidenceKind | null;
}

/**
 * The prompt block. Empty string when there is nothing to adjudicate, so the
 * caller can concatenate unconditionally.
 *
 * Note what it does NOT say: it never names the candidate as likely, never
 * gives it a confidence, and never suggests the model is being unhelpful by
 * rejecting one. A prompt that leans produces a model that agrees.
 */
export function buildCandidateBlock(
  candidates: readonly VisualCandidate[],
): string {
  const usable = candidates.filter((c) => c.field && c.value && c.support > 0);
  if (usable.length === 0) return "";

  const lines = usable.map(
    (c) =>
      `- ${c.field}: "${c.value}" (declared by ${c.support} of ${c.outOf} similar listings)`,
  );

  return [
    "UNVERIFIED EXTERNAL GUESS — eBay visual match.",
    "",
    "These come from live listings whose PHOTOS resemble this garment. They are",
    "NOT ground truth and they are NOT more likely to be right than what you can",
    "read yourself. A visual match cannot see a tag; it matches silhouette,",
    "pattern and colour, so it returns a confident answer even when the photo",
    "contains no brand mark at all.",
    "",
    ...lines,
    "",
    "For each one, decide: does the PHOTO EVIDENCE support it?",
    "",
    "Precedence, strongest first. A lower item never overrides a higher one:",
    "  1. a style/model code printed on the tag",
    "  2. a brand wordmark you can actually read in a photo",
    "  3. these visual-match candidates",
    "  4. your own knowledge of the product line",
    "",
    "Rules:",
    "- If a tag in the photos contradicts a candidate, REJECT it. The tag wins,",
    "  however many listings agreed.",
    "- Accept a candidate only if you can name which evidence supports it.",
    "- Rejecting is a correct and expected outcome, not a failure to be helpful.",
    "- Never copy a candidate into a field you would otherwise have left empty",
    "  purely because it was offered.",
  ].join("\n");
}

/**
 * Drop accepted candidates that named no evidence.
 *
 * WHY THIS IS SERVER-SIDE AND NOT A PROMPT RULE. "Accept only with evidence" is
 * an instruction; a model under pressure to be useful will accept anyway and
 * leave the field blank. The same reasoning is already applied to research-tier
 * identifications, which are dropped below RESEARCH_MIN_CONFIDENCE rather than
 * trusted to self-censor. An unevidenced acceptance is exactly the anchoring
 * this module exists to prevent, so it is removed here where it cannot argue.
 */
export function dropUnevidenced(
  rulings: readonly CandidateRuling[],
): CandidateRuling[] {
  return rulings.filter(
    (r) => r.verdict !== "accepted" || r.evidence !== null,
  );
}

/**
 * Candidates the model accepted, as field → value.
 *
 * Rejections are NOT merged in and are not silently discarded either - the
 * caller records them. Measuring how often the visual provider is overruled is
 * the only way to find out whether it is earning its latency, and an experiment
 * nobody measured is how the title-consensus mistake survived to production.
 */
export function acceptedValues(
  rulings: readonly CandidateRuling[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of dropUnevidenced(rulings)) {
    if (r.verdict === "accepted" && r.field && r.value) out[r.field] = r.value;
  }
  return out;
}

/**
 * Resolve two sources claiming the same field.
 *
 * Ties go to the INCUMBENT (the value already held), because a candidate that
 * merely matches the strength of what we have adds no information and changing
 * a field for no reason is how a correct value gets replaced by a plausible one.
 */
export function resolveByPrecedence<T extends { kind: EvidenceKind }>(
  incumbent: T | null,
  challenger: T | null,
): T | null {
  if (!incumbent) return challenger;
  if (!challenger) return incumbent;
  return evidenceRank(challenger.kind) < evidenceRank(incumbent.kind)
    ? challenger
    : incumbent;
}
