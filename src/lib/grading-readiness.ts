import {
  REQUIRED_GRADING_PHOTO_TYPES,
  FABRIC_CLOSEUP_PHOTO_TYPES,
} from "@/lib/constants";

// Client-side mirror of buildValidation() in
// services/edge-functions/src/routes/flipdesk-grading.ts. It lets the "Submit
// for grading" card reflect readiness LIVE off the edit form + photo cache,
// instead of only after a save bumps items_full.updated_at and a server
// /validate round-trip (the old "set the requirement, then save, then grading
// notices" friction).
//
// The blocker STRINGS below are verbatim copies of the server's so the two can
// never visibly disagree and the card's onlyGarmentBlocks regex keeps matching.
// The server /validate + /submit remain the authoritative gate — this only
// drives the optimistic UI; /submit re-checks the persisted row.

export interface GradingReadinessInput {
  garment_type: string | null | undefined;
  garment_category: string | null | undefined;
  title: string | null | undefined;
  // The photo_type values currently attached to the item.
  photoTypes: Set<string> | readonly string[];
}

export interface GradingReadiness {
  ready: boolean;
  blockers: string[];
  /**
   * US-2397: things worth telling the seller that do NOT stop submission.
   * `ready` ignores them on purpose — a warning that blocks is just a blocker
   * with softer wording, which is what the fabric close-up rule used to be.
   */
  warnings: string[];
}

// Verbatim copy of FABRIC_CLOSEUP_WARNING in the edge authority
// (services/edge-functions/src/routes/flipdesk-grading.ts). Both are asserted
// against src/test/fixtures/grading-readiness-cases.json, so an edit to one
// fails the other project's suite rather than drifting quietly.
export const FABRIC_CLOSEUP_WARNING =
  "No fabric close-up, so a person will check this grade before it is final. Add a detail photo of the weave/knit or a seam for a faster, more certain grade. This isn't a defect shot.";

/**
 * US-2467: does this photo set contain an actual fabric close-up?
 *
 * Before roles this could only ask "is any Detail slot filled", so four photos
 * of buttons passed the check and dodged NO_FABRIC_CLOSEUP_CONFIDENCE_CAP,
 * while one perfect fabric macro tagged "Detail 3" only counted by luck. The
 * fabric_condition factor is 30% of the score, so that was a real accuracy hole
 * rather than a tidiness problem.
 *
 * `have` may hold bare types ("detail") and/or role-qualified slots
 * ("detail:fabric", and "detail:" for a detail with NO role). The three cases,
 * in order:
 *
 *   1. An explicit fabric close-up. Always counts.
 *   2. An explicitly UNQUALIFIED detail. Counts, because the seller never said
 *      what it was and it may well be the weave — the same benefit of the doubt
 *      the old rule gave, deliberately preserved so no historical item is
 *      retro-capped.
 *   3. A caller that knows nothing about roles (a legacy row set, the shared
 *      fixture, or an older client) — recognised by there being detail photos
 *      but no qualified slot among them. Falls back to the old behavior.
 *
 * What no longer counts: a detail set where EVERY photo is qualified as
 * something that is not fabric. That is the case the old rule got wrong.
 */
export function hasFabricCloseup(have: Set<string>): boolean {
  if (have.has("detail:fabric")) return true;
  if (have.has("detail:")) return true;

  const details = [...have].filter(
    (s) =>
      s === "detail" ||
      s.startsWith("detail:") ||
      (FABRIC_CLOSEUP_PHOTO_TYPES as readonly string[]).includes(s),
  );
  if (details.length === 0) return false;
  const qualified = details.filter((s) => s.startsWith("detail:") && s !== "detail:");
  return qualified.length === 0;
}

export function previewGradingReadiness(
  input: GradingReadinessInput,
): GradingReadiness {
  const have =
    input.photoTypes instanceof Set
      ? input.photoTypes
      : new Set(input.photoTypes);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.garment_type) blockers.push("Missing garment_type");
  if (!input.garment_category) blockers.push("Missing garment_category");
  if (!input.title || !input.title.trim()) blockers.push("Missing title");

  // US-2304: the GRADING list, not the listing one. A tagless garment may be
  // listed; it may not be graded, because the grading gate blocks on a missing
  // label after the seller has already been charged.
  const missingPhotos = REQUIRED_GRADING_PHOTO_TYPES.filter((t) => !have.has(t));
  if (missingPhotos.length > 0) {
    blockers.push(`Missing required photos: ${missingPhotos.join(", ")}`);
  }

  if (!hasFabricCloseup(have)) {
    warnings.push(FABRIC_CLOSEUP_WARNING);
  }

  return { ready: blockers.length === 0, blockers, warnings };
}
