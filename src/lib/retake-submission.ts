import type { ImageType } from "@/types/database";

// US-949: one-tap retake bridge — passed as React Router navigation state from
// submission-detail.tsx to new-submission.tsx when the seller taps "Retake
// photos" on a needs_photos (low-confidence/quality-gate abstained) or expired
// (checkout never completed) submission. The new submission references the prior
// one (retake_of) and supersedes it server-side, so a low-confidence result is
// no longer a dead end. All photo/garment signals are optional so new-submission
// degrades gracefully if any is missing.
export interface RetakeBridgeState {
  /** The prior submission being retaken — referenced + superseded on submit. */
  priorSubmissionId: string;
  garmentType?: string;
  garmentCategory?: string;
  brand?: string;
  title?: string;
  description?: string;
  styleAttributes?: string[];
  /** Inventory item linked to the prior submission, preserved across the retake. */
  linkedItemId?: string | null;
  /** image_types the grader flagged as needing a better photo (highlighted). */
  flaggedImageTypes: ImageType[];
  /** The grader's human-readable photo requests, shown as guidance. */
  photoRequests: string[];
  /**
   * Passing photos to re-stage so the seller only retakes the flagged ones.
   * `signedUrl` is a short-lived (≤900s) signed URL into the private
   * submission-images bucket, fetched + re-staged immediately on arrival.
   */
  reusablePhotos: { imageType: ImageType; signedUrl: string }[];
}
