// US-2212: dating a garment from its tag generation.
//
// brand_knowledge.tag_eras has carried [{era, years, description}] since 00389
// and NOTHING has ever read it. brand-knowledge.ts carries it through the pack
// shape and selects the column; three brand-normalize.ts comments mention it in
// prose. No prompt injects it, no comparison uses it, nothing surfaces it. This
// module is its first consumer.
//
// Era matters because for whole categories it IS the price: a single-stitch
// Champion blue-bar sweatshirt and a modern sleeve-C one are the same silhouette
// in the same colours and an order of magnitude apart (00465). The garment
// announces which it is, on the neck tag, in a photograph we already take.
//
// ── WHERE THE MATCH HAPPENS, AND WHY NOT IN THE GRADING PROMPTS ─────────────
//
// The match rides on the DEDICATED TAG-OCR CALL (US-2210), not on the per-image
// or composite grading prompts. That call already looks at the label alone and
// is already gated behind GRADING_TAG_OCR, so:
//
//   * the three lockstep-governed grading prompts are untouched — factor scores
//     are provably unaffected rather than argued to be, and a test pins it;
//   * the reference list is shown to a call whose entire job is reading a label,
//     which is where a "which of these tag generations is this?" question
//     belongs.
//
// ── A DATING ERA IS NOT A FORMAT NOTE ──────────────────────────────────────
//
// FOUND WHILE IMPLEMENTING, and it shapes this module: the column is doing
// DOUBLE DUTY. Of 220 seeded entries, ~174 carry a real date range and the rest
// carry `years: "all"` or `"current"` — Nike's "style-number" entry, adidas's
// "article-number" entry, Ralph Lauren's "label" entry. Those describe a code
// FORMAT that has never changed, which is useful knowledge and is NOT dating
// evidence. Offering them as datable eras would invite a confident "this is from
// the all era" answer, so `datingEras()` filters them out and only the survivors
// are ever presented.
//
// Pure — no network, no DB, no model — so every rule here is unit-testable.

/** One seeded tag generation, after coercion from the stored jsonb. */
export interface TagEra {
  /** Short label, e.g. "blue bar" or "2019-present". */
  era: string;
  /** Year range as written, e.g. "1980s-early 90s", "2019+", "all". */
  years: string;
  /** What the tag of this generation looks like. */
  description: string;
  /**
   * US-2212 AC5. Where this dating claim comes from, PER ENTRY.
   *
   * brand_knowledge carries source_url / confidence / verified on the ROW, so
   * an unsourced era sitting inside an otherwise-verified brand was
   * indistinguishable from a cited one. Era IS the price on a vintage piece —
   * it is the highest-liability content in the knowledge base — so it gets the
   * treatment the registered-number work chose: an RN we cannot cite is
   * invention, and so is a decade.
   *
   * Null on every one of the ~220 entries seeded before this landed. See
   * `isSourcedEra` for what that permits and what it refuses.
   */
  sourceUrl: string | null;
  /** 0..1 confidence in the DATING CLAIM itself, not in a transcription. */
  sourceConfidence: number | null;
}

/** A stable id the model returns instead of re-typing free text. */
export function eraId(index: number): string {
  return `era_${index + 1}`;
}

/**
 * Coerce the stored jsonb array into TagEras. Rows are hand-authored across 32
 * migrations, so anything missing an era label or a description is dropped
 * rather than half-rendered — a reference line the model cannot act on is
 * prompt tokens spent to no effect.
 */
export function normalizeTagEras(raw: unknown): TagEra[] {
  if (!Array.isArray(raw)) return [];
  const out: TagEra[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const era = typeof o.era === "string" ? o.era.trim() : "";
    const description = typeof o.description === "string"
      ? o.description.trim()
      : "";
    const years = typeof o.years === "string" ? o.years.trim() : "";
    if (era.length === 0 || description.length === 0) continue;
    // Absent provenance stays NULL rather than defaulting. A default here would
    // make every legacy entry look cited, which is the exact confusion AC5
    // exists to end.
    const sourceUrl = typeof o.source_url === "string" && o.source_url.trim()
      ? o.source_url.trim()
      : null;
    const rawConf = typeof o.confidence === "number"
      ? o.confidence
      : Number(o.confidence);
    const sourceConfidence = Number.isFinite(rawConf)
      ? Math.max(0, Math.min(1, rawConf))
      : null;
    out.push({ era, years, description, sourceUrl, sourceConfidence });
  }
  return out;
}

// A `years` value is dating evidence only if it names a year or a decade.
// "all", "current", "ongoing" and "" describe something that never changed.
const YEAR_LIKE = /\d{4}|\d0s\b/;

/**
 * Keep only the entries that can actually date a garment. See the header: the
 * column mixes dating generations with never-changed format notes, and offering
 * the latter as an era invites a confident, meaningless answer.
 */
export function datingEras(eras: TagEra[]): TagEra[] {
  return eras.filter((e) => YEAR_LIKE.test(e.years));
}

/** Cap the reference block so one over-seeded brand cannot dominate the call. */
export const MAX_ERAS_IN_PROMPT = 12;

/**
 * Render the era reference shown to the tag-OCR call. Returns "" when the brand
 * has no datable generations, which keeps the whole feature strictly additive:
 * an empty block means a byte-identical prompt.
 *
 * The instruction is deliberately permissive about ABSTAINING. A brand's eras
 * are the ones we happen to have seeded, never a complete history, so "none of
 * these" has to be an available and unpenalised answer — otherwise the model is
 * cornered into picking the closest of a list that may not contain the answer,
 * which is precisely how a guessed decade ends up on a certificate.
 */
export function tagEraReferenceBlock(eras: TagEra[]): string {
  const datable = datingEras(eras).slice(0, MAX_ERAS_IN_PROMPT);
  if (datable.length === 0) return "";
  const lines = datable.map((e, i) =>
    `- ${eraId(i)} | ${e.era}${e.years ? ` (${e.years})` : ""}: ${e.description}`
  );
  return [
    "KNOWN TAG GENERATIONS for this brand (reference — this list is NOT exhaustive):",
    ...lines,
    "If the label clearly matches ONE of these generations, return its id in tag_era with a confidence.",
    "If it matches none, is ambiguous between two, or the brand's tag is not visible, OMIT tag_era entirely. Omitting is the correct answer whenever you are unsure — a wrong date is worse than no date.",
  ].join("\n");
}

/** The era a read resolved to, ready to render and persist. */
export interface MatchedTagEra {
  era: string;
  years: string;
  description: string;
  confidence: number;
  /**
   * US-2212 AC5. False when the matched entry carries no per-entry provenance.
   * The match is still returned — the era-vs-decoder consistency check (AC4) is
   * an internal flag and works fine off an uncited era — but nothing may
   * PUBLISH it. `sourceUrl` is what a surface cites.
   */
  sourced: boolean;
  sourceUrl: string | null;
}

/**
 * Below this a dating claim is not shown or persisted. Set ABOVE the tag-OCR
 * field bar (0.4) on purpose: transcribing "Levi's" at 0.5 still gives a usable
 * brand, whereas a half-sure decade is a fabricated provenance claim on a public
 * certificate. Dating is an inference over a reference list, not a transcription,
 * so it earns a stricter bar than the fields around it.
 */
export const ERA_MATCH_MIN_CONFIDENCE = 0.7;

/**
 * Is this era citable? (US-2212 AC5)
 *
 * A dating claim needs BOTH a source and a stated confidence in the claim
 * itself. One without the other is not provenance: a URL with no confidence
 * says where someone looked but not what they concluded, and a confidence with
 * no URL is a number with nothing behind it.
 */
export function isSourcedEra(era: TagEra): boolean {
  return Boolean(era.sourceUrl) && typeof era.sourceConfidence === "number";
}

/**
 * THE SPLIT THAT MAKES AC5 SHIPPABLE, rather than a switch that turns the
 * feature off.
 *
 * AC5's words are about "an unsourced era claim on a PUBLIC CERTIFICATE". That
 * is a statement about what we PUBLISH, not about what the model may read. Two
 * different uses with two different liabilities:
 *
 *   REFERENCE  — the era list rendered into the tag-OCR call. Unsourced entries
 *                stay, because they help the model read the label and nothing
 *                they produce is published on their own.
 *   CLAIM      — a matched era persisted and surfaced. Requires provenance,
 *                because that is the thing a buyer reads and pays for.
 *
 * Requiring provenance for the reference block too would have silenced the
 * whole feature — all ~220 seeded entries predate this — and called it a fix.
 * Requiring it for the claim means the era can still be READ today and cannot
 * be SOLD until someone cites it, which is what the AC actually asks.
 */
export function claimableEras(eras: TagEra[]): TagEra[] {
  return datingEras(eras).filter(isSourcedEra);
}

/**
 * Resolve the model's returned id back to a seeded entry. Returns null for an
 * unknown id, a hallucinated one, or a below-bar confidence — the model may not
 * introduce an era that is not in the reference list, which is what keeps this
 * grounded in curated knowledge rather than model memory.
 *
 * NOTE the resolution is against `datingEras(...)` in the SAME order the block
 * was rendered in, so ids stay stable end-to-end.
 */
export function matchTagEra(
  eras: TagEra[],
  id: unknown,
  confidence: unknown,
  minConfidence: number = ERA_MATCH_MIN_CONFIDENCE,
): MatchedTagEra | null {
  if (typeof id !== "string" || id.trim().length === 0) return null;
  const conf = typeof confidence === "number" ? confidence : Number(confidence);
  if (!Number.isFinite(conf) || conf < minConfidence) return null;
  const datable = datingEras(eras).slice(0, MAX_ERAS_IN_PROMPT);
  const index = datable.findIndex((_, i) => eraId(i) === id.trim());
  if (index < 0) return null;
  const hit = datable[index];
  return {
    era: hit.era,
    years: hit.years,
    description: hit.description,
    confidence: Math.max(0, Math.min(1, conf)),
    // Carried rather than filtered, so a caller has to DECIDE. Dropping the
    // match here would silently disable the AC4 consistency check on every
    // legacy entry, which is a different feature being switched off by a change
    // about publishing.
    sourced: isSourcedEra(hit),
    sourceUrl: hit.sourceUrl,
  };
}

// ── Era vs a decoded year (US-2212 AC4) ────────────────────────────────────
//
// The one place an era can be CHECKED rather than merely recorded. When a tag's
// style code decodes to a production year (brand-decoders.ts) AND the label's
// design matched a dated generation, the two are independent readings of the
// same garment and they have to agree. A 2019-format Lululemon style number on
// a tag whose design belongs to a 2008-2012 generation is a genuine
// inconsistency: the commonest innocent cause is a relabelled or franken-tagged
// garment, and the commonest guilty one is a counterfeit that copied a current
// code onto a vintage-look tag.
//
// It is a FLAG, never a verdict — US-1770's no-auto-authenticate posture holds.
// Nothing here concludes anything about authenticity; it hands a human two
// dates that cannot both be right.

/** Inclusive year bounds parsed out of a free-text `years` string. */
export interface EraYearRange {
  from: number;
  to: number;
}

const CURRENT_ISH = /present|current|ongoing|now|\+/i;

/**
 * Parse "1980s-early 90s", "2019-present", "1997-2004", "1990s" into bounds.
 * Returns null when no year can be read — the seeded strings are hand-authored
 * prose and a range we cannot parse must yield NO check rather than a guessed
 * one. `upperBoundYear` closes an open-ended range (pass the current year).
 *
 * Two-digit years are read within the century their neighbour establishes
 * ("1980s-early 90s" is 1980-1999, not 1980-0090), which is the actual shape
 * the corpus uses.
 */
export function eraYearRange(
  years: string,
  upperBoundYear: number,
): EraYearRange | null {
  if (!years) return null;
  const decades = [...years.matchAll(/(\d{4})s/g)].map((m) => Number(m[1]));
  const fours = [...years.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => Number(m[1]));
  if (fours.length === 0) return null;

  let from = Math.min(...fours);
  // A "1980s" token means the whole decade, so it can only widen the top.
  let to = Math.max(...fours, ...decades.map((d) => d + 9));

  // "…-early 90s" / "…-'95": a trailing 2-digit year borrows the century of the
  // range's start, which is how every seeded string is written.
  const twoDigit = [...years.matchAll(/(?<![\d'\u2019])(\d{2})s?(?!\d)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  for (const td of twoDigit) {
    const century = Math.floor(from / 100) * 100;
    const candidate = century + td;
    const resolved = candidate < from ? candidate + 100 : candidate;
    if (resolved > to) to = /s$/.test(years) || decades.length > 0 ? resolved + 9 : resolved;
  }

  if (CURRENT_ISH.test(years)) to = Math.max(to, upperBoundYear);
  if (to < from) [from, to] = [to, from];
  return { from, to };
}

export interface EraDecoderConflict {
  /** Stable code, mirroring brand-decoders.ts DecodeInconsistency. */
  code: "era_year_mismatch";
  severity: "flag";
  message: string;
  decodedYear: number;
  era: string;
  eraYears: string;
}

/**
 * Compare a decoder-derived production year against the matched tag generation.
 * Returns null — meaning NO finding — whenever the check cannot be made
 * honestly: no era, no decoded year, or a `years` string we could not parse.
 * A tolerance absorbs the ordinary case of a tag generation whose real
 * changeover straddles the year boundary our prose records.
 */
export const ERA_YEAR_TOLERANCE = 1;

export function eraDecoderConflict(
  // Structurally typed on the ONE field it reads, not on MatchedTagEra. US-2212
  // AC5 added provenance to that shape, and this check does not care about it —
  // an uncited era still cannot be from two decades at once. Narrowing the
  // parameter says so, and stops a future provenance field from looking like it
  // belongs in a consistency comparison.
  era: Pick<MatchedTagEra, "era" | "years"> | null,
  decodedYear: number | null | undefined,
  currentYear: number,
): EraDecoderConflict | null {
  if (!era || typeof decodedYear !== "number" || !Number.isFinite(decodedYear)) {
    return null;
  }
  const range = eraYearRange(era.years, currentYear);
  if (!range) return null;
  if (
    decodedYear >= range.from - ERA_YEAR_TOLERANCE &&
    decodedYear <= range.to + ERA_YEAR_TOLERANCE
  ) {
    return null;
  }
  return {
    code: "era_year_mismatch",
    severity: "flag",
    message:
      `The style code decodes to ${decodedYear}, but the label's design matches ` +
      `the "${era.era}" tag generation (${era.years}). Both readings cannot be ` +
      "right. Review — this is a flag, not a verdict.",
    decodedYear,
    era: era.era,
    eraYears: era.years,
  };
}
