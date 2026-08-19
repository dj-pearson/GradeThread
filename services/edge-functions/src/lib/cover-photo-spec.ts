// US-2681: the §11 cover-photo spec, and nothing else.
//
// Its own module for a dependency reason, not a tidiness one. publish-preflight
// is a PURE module — no network, no client, unit-tested directly — and importing
// these four names from ai-photo-qa.ts pulled the Anthropic SDK and the Supabase
// client in behind them. The test-env-isolation guard caught it immediately,
// which is what that guard is for.
//
// So the vocabulary lives here, where both the assessor that PRODUCES these
// issues and the preflight that REPORTS them can read it without either taking
// on the other's dependencies.
//
// ── The spec itself ────────────────────────────────────────────────────────
//
// eBay image search is a second, separate index. It embeds the buyer's query
// photo and matches it against listing images, so the lead photo is not only
// the click-through lever of playbook §6 — it is the retrieval key for every
// buyer who searches by picture or taps "find similar".
//
// What that index rewards is a stricter spec than "a nice photo", and §11 names
// it: the garment filling the frame, one garment per photo, a plain
// high-contrast ground so the silhouette segments cleanly, and no props or
// hands. These four are checkable, which is why they are here.
//
// §11 also names "no overlay text". It is deliberately NOT in this list: eBay's
// own image policy already refuses overlay text at publish, so a warning here
// would duplicate a hard rejection the seller gets anyway, with less authority.
// These four have no other enforcement.
//
// SLOT 1 ONLY, which is the reason they carry their own prefix. A tag close-up
// SHOULD fill the frame with a label; a detail shot of a cuff is meant to be a
// fragment. Applying these to every photo would flag good photos for being what
// they are.

export const COVER_ISSUE_TYPES = [
  /** The garment does not fill the frame — the silhouette is too small to embed. */
  "cover_garment_small",
  /** More than one garment in shot, so there is no single subject to match. */
  "cover_multiple_garments",
  /** Busy or low-contrast ground; the silhouette does not segment cleanly. */
  "cover_busy_background",
  /** A prop, a hand or a hanger-holder in frame, competing with the garment. */
  "cover_prop_in_frame",
] as const;
export type CoverIssueType = (typeof COVER_ISSUE_TYPES)[number];

/** True for the §11 cover-photo checks, which apply to slot 1 and nowhere else. */
export function isCoverIssue(type: string): type is CoverIssueType {
  return (COVER_ISSUE_TYPES as readonly string[]).includes(type);
}

/** The shape both callers share. Structural, so neither owns the other's type. */
export interface CoverIssueLike {
  type: string;
  message: string;
}

export type CoverPhotoStatus = "unknown" | "clean" | "issues";

export interface CoverPhotoAssessment<T extends CoverIssueLike = CoverIssueLike> {
  status: CoverPhotoStatus;
  issues: T[];
}

/**
 * Read the §11 cover-photo verdict off a QA result.
 *
 * "unknown" is the important one and is NOT the same as "clean". An item whose
 * photos were never assessed has no verdict, and reporting no issues for it
 * would be the nudge claiming a check that never ran — worse than silence,
 * because a seller told their cover photo is fine stops looking at it.
 *
 * Pure: the caller supplies the result, or null when there is none.
 */
export function coverPhotoAssessment<T extends CoverIssueLike>(
  qa: { issues: T[] } | null | undefined,
): CoverPhotoAssessment<T> {
  if (!qa || !Array.isArray(qa.issues)) return { status: "unknown", issues: [] };
  const issues = qa.issues.filter((i) => isCoverIssue(i.type));
  return { status: issues.length > 0 ? "issues" : "clean", issues };
}

/** One line per cover issue, in the shape the preflight's warnings array holds. */
export function coverPhotoWarnings(assessment: CoverPhotoAssessment): string[] {
  return assessment.issues.map((issue) => issue.message);
}
