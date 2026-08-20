// US-2691: which answer wins when several sources name the same style code.
//
// 00628 stores one row per source per code, deliberately, because the sources
// disagree and each is right about something different. This module owns the
// order they lose in. It is the ONLY place that order exists — a rank column in
// the table would be a second copy of the same rule, free to drift from this one.
//
// Precedence, strongest first:
//
//   official   the brand published this name. Nothing outranks the manufacturer.
//   admin      a human operator with the whole index in front of them.
//   seller     the person holding the garment corrected us. Beats any amount of
//              market chatter about the same code — they can read the tag.
//   consensus  the run of words most listings share. The weakest that stands
//              on its own, and the only one that scales.
//   public     a visitor to the lookup told us (US-2749). Ranked last, and the
//              only source that CANNOT stand on one report: see
//              PUBLIC_MIN_SUBMISSIONS. An anonymous stranger holding the
//              garment is real evidence and is also the easiest to forge.
//
// Confidence does NOT decide this. A consensus over forty listings can carry a
// higher number than a one-off seller correction and still lose, because the
// question is not "which is better attested" but "who is in a position to know".

/** Every source 00628 accepts, strongest first. Order IS the precedence. */
export const NAME_SOURCE_ORDER = [
  "official",
  "admin",
  "seller",
  "consensus",
  "public",
] as const;

/**
 * US-2749: how many independent people must say the same thing before a
 * public submission is shown as the answer.
 *
 * One report is a person who might be right, might be guessing, or might be a
 * competitor. Two is the cheapest bar that is not one, and it is the same
 * reasoning as the consensus threshold: a single sighting is a coincidence.
 * Below this the row exists and is simply not used.
 */
export const PUBLIC_MIN_SUBMISSIONS = 2;

export type NameSource = typeof NAME_SOURCE_ORDER[number];

export interface StyleCodeNameRow {
  name: string;
  source: string;
  supporting: number;
  confidence: number;
  evidence_url: string | null;
  /** 00628 records a rejection rather than deleting, so the sweep cannot
   *  re-learn the same wrong name from the same evidence. */
  rejected_at?: string | null;
}

export interface ResolvedStyleCodeName {
  name: string;
  source: NameSource;
  supporting: number;
  confidence: number;
  evidenceUrl: string | null;
}

/** Rank for sorting; unknown sources sort last rather than throwing. */
export function nameSourceRank(source: string): number {
  const i = (NAME_SOURCE_ORDER as readonly string[]).indexOf(source);
  return i === -1 ? NAME_SOURCE_ORDER.length : i;
}

/**
 * The winning name for one code, or null.
 *
 * Rejected rows are dropped outright — a rejected name is not a weaker answer,
 * it is a wrong one, and falling back to it when nothing else exists would
 * reintroduce exactly what an operator removed.
 *
 * Ties inside one source (which the 00628 unique key makes impossible in the
 * database, but not in a caller's array) go to the better-attested row, then to
 * the higher confidence. Pure.
 */
export function pickStyleCodeName(
  rows: readonly StyleCodeNameRow[],
): ResolvedStyleCodeName | null {
  const usable = rows.filter(
    (r) =>
      !r.rejected_at && r.name.trim() !== "" &&
      nameSourceRank(r.source) < NAME_SOURCE_ORDER.length &&
      // US-2749: a public submission needs corroboration before it is an
      // answer. Filtered here rather than at the write site so the row is
      // still recorded, still counted, and still visible to an admin — it is
      // under-supported, not rejected.
      (r.source !== "public" || r.supporting >= PUBLIC_MIN_SUBMISSIONS),
  );
  if (usable.length === 0) return null;

  const best = usable.reduce((a, b) => {
    const rankDelta = nameSourceRank(a.source) - nameSourceRank(b.source);
    if (rankDelta !== 0) return rankDelta < 0 ? a : b;
    if (a.supporting !== b.supporting) return a.supporting > b.supporting ? a : b;
    return a.confidence >= b.confidence ? a : b;
  });

  return {
    name: best.name.trim(),
    source: best.source as NameSource,
    supporting: best.supporting,
    confidence: best.confidence,
    evidenceUrl: best.evidence_url,
  };
}
