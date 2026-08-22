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
  /**
   * How many of the searched photos surfaced a listing declaring this (US-2780).
   *
   * A SECOND KIND OF EVIDENCE, not more of the first. Five listings agreeing off
   * one flatlay is the teal-tank case from
   * vault/30-platform/ebay-visual-search.md: no brand mark in frame, five
   * confident Lululemon results, and no way to tell from the photo. Five
   * agreeing across three angles is a different claim, and the listing count
   * alone cannot express the difference.
   *
   * Absent on candidates built from a single photo (US-2778), which is why the
   * clause is omitted rather than printed as "1 of 1".
   */
  photosAgreeing?: number;
  /** How many photos were searched at all. */
  photosSearched?: number;
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

  const lines = usable.map((c) => {
    // US-2780: only when more than one photo was actually searched. "on 1 of 1
    // photos searched" is noise - it is the only thing it could say - and
    // printing it would change every single-photo prompt for no reason.
    const across = (c.photosSearched ?? 0) > 1
      ? `, on ${c.photosAgreeing ?? 0} of ${c.photosSearched} photos searched`
      : "";
    return `- ${c.field}: "${c.value}" (declared by ${c.support} of ${c.outOf} similar listings${across})`;
  });

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
    // US-2780. Stated as a fact about what the number MEANS, not as a
    // threshold: a threshold here would be this block filtering on the model's
    // behalf, which is the one thing it is built not to do.
    "- Where a candidate was searched on several photos, the photo count is a",
    "  second kind of evidence. Many listings agreeing off ONE angle can all be",
    "  answering the silhouette rather than the garment; agreement across angles",
    "  is harder to get by accident. Weigh it, do not treat it as a cutoff.",
    "",
    // WITHOUT THIS the block asks for a decision and gives it nowhere to go.
    // The rules above were unenforceable for exactly that reason: the model was
    // told to name its evidence and had no field to name it in.
    "Report every decision in visual_rulings, one entry per candidate above:",
    "  field, value, verdict (\"accepted\" or \"rejected\"), and on an",
    "  acceptance, evidence — one of: style_code, tag_wordmark,",
    "  visual_consensus, model_knowledge.",
    "An acceptance naming no evidence is discarded, so leaving it out is the",
    "same as rejecting it.",
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
/**
 * Read the model's rulings out of a tool payload, defensively.
 *
 * Anything malformed is DROPPED rather than coerced. A ruling is only ever used
 * to remove a suggestion, so a half-parsed one can only cause a wrong removal -
 * and silently discarding a garbled rejection is the safer of the two failures.
 */
export function parseRulings(raw: unknown): CandidateRuling[] {
  if (!Array.isArray(raw)) return [];
  const out: CandidateRuling[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const field = typeof r.field === "string" ? r.field.trim() : "";
    const value = typeof r.value === "string" ? r.value.trim() : "";
    if (!field || !value) continue;
    const verdict = r.verdict === "accepted" || r.verdict === "rejected"
      ? r.verdict
      : null;
    if (!verdict) continue;
    const ev = typeof r.evidence === "string" ? r.evidence : "";
    const evidence = (EVIDENCE_PRECEDENCE as readonly string[]).includes(ev)
      ? (ev as EvidenceKind)
      : null;
    out.push({ field, value, verdict, evidence });
  }
  return out;
}

/**
 * Remove any suggestion the model itself rejected.
 *
 * THIS IS THE ENFORCEMENT, and the reason the rest of the module is worth
 * anything. A model that writes "rejected: Lululemon" and then puts Lululemon
 * in the brand field has told us two things and we were believing the wrong
 * one - the free-text verdict costs it nothing, while the field is what reaches
 * the seller's listing.
 *
 * Matching is trimmed and case-insensitive, because "lululemon" and
 * "Lululemon" are the same rejection. It is also VALUE-SCOPED: a rejected brand
 * only clears the brand field when the field still holds that same brand, so a
 * model that rejects the candidate and independently reads a DIFFERENT brand off
 * the tag keeps its own answer.
 */
export function applyRulings<T extends { value: string }>(
  suggestions: Record<string, T>,
  rulings: readonly CandidateRuling[],
): Record<string, T> {
  const rejected = new Map<string, Set<string>>();
  for (const r of rulings) {
    if (r.verdict !== "rejected") continue;
    const key = r.field.trim().toLowerCase();
    if (!rejected.has(key)) rejected.set(key, new Set());
    rejected.get(key)!.add(r.value.trim().toLowerCase());
  }
  if (rejected.size === 0) return suggestions;

  const out: Record<string, T> = {};
  for (const [field, suggestion] of Object.entries(suggestions)) {
    const bad = rejected.get(field.trim().toLowerCase());
    if (bad && bad.has(String(suggestion.value).trim().toLowerCase())) continue;
    out[field] = suggestion;
  }
  return out;
}

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
