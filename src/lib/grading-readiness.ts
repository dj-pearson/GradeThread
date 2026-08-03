import {
  REQUIRED_PHOTO_TYPES,
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

  const missingPhotos = REQUIRED_PHOTO_TYPES.filter((t) => !have.has(t));
  if (missingPhotos.length > 0) {
    blockers.push(`Missing required photos: ${missingPhotos.join(", ")}`);
  }

  if (!FABRIC_CLOSEUP_PHOTO_TYPES.some((t) => have.has(t))) {
    warnings.push(FABRIC_CLOSEUP_WARNING);
  }

  return { ready: blockers.length === 0, blockers, warnings };
}
