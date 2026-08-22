// US-2538 / US-774 / US-2789: what pressing Submit should actually do.
//
// WHY THIS IS A FUNCTION AND NOT FOUR `if`s IN A HANDLER. The ordering here is
// money logic, and it was previously pinned only by a test comparing STRING
// INDEXES inside new-submission.tsx — asserting that `if (repricingSubmissionId)`
// appeared before `new FormData()`. That holds the branch's POSITION and can say
// nothing about what it decides. Reorder two gates correctly and the scan still
// passes; reorder them incorrectly and it also passes, as long as the strings
// stay in order.
//
// THE BUG THIS ORDERING EXISTS FOR (US-2538): when /api/grade/submit answers
// `checkoutRequired`, the submission row ALREADY EXISTS and sits unpaid. "Change
// tier" cleared the checkout state and put Submit back in front of the seller,
// so pressing it again POSTed /submit a second time and created a SECOND row for
// the same garment. Two rows, two charges, one garment.
//
// So `reprice` must win over EVERY other gate, including the ones that look more
// urgent. That is the part worth being able to test by calling.

export type SubmitAction = "reprice" | "submit" | "ignore";

export interface SubmitState {
  /** Set once a submission exists and is waiting to be paid for. */
  repricingSubmissionId: string | null;
  /** False before the garment form is complete. */
  hasGarmentInfo: boolean;
  captureMode: "photo" | "video";
  hasVideo: boolean;
  photoCount: number;
  /** The synchronous re-entrancy latch (US-774). */
  locked: boolean;
}

/**
 * The single decision behind the Submit button.
 *
 * ORDER IS THE CONTRACT, and each step is here for a different failure:
 *
 *  1. No garment info — nothing to submit yet. First because every later gate
 *     reads fields that do not exist without it.
 *  2. A submission is already awaiting payment — RE-PRICE it. Ahead of the
 *     media and lock checks on purpose: the row exists, so the media that
 *     created it is already uploaded, and re-checking `photos.length` here
 *     would refuse to re-price a submission whose photos the component no
 *     longer holds. That refusal is invisible — the button does nothing — and
 *     the seller's escape from it is to start again, which is the double row
 *     this whole path exists to prevent.
 *  3. No media — nothing to upload.
 *  4. Locked — a re-entrant double-click, rejected synchronously.
 */
export function decideSubmitAction(s: SubmitState): SubmitAction {
  if (!s.hasGarmentInfo) return "ignore";
  if (s.repricingSubmissionId) return "reprice";
  const hasMedia = s.captureMode === "video" ? s.hasVideo : s.photoCount > 0;
  if (!hasMedia) return "ignore";
  if (s.locked) return "ignore";
  return "submit";
}
