// US-2504 (slice 1 of N): the multipart contract for grading from a walk-around
// clip, written down in one place.
//
// Why this file exists. The web page posts these field names inline in
// new-submission.tsx and the edge reads them inline in routes/grade.ts. That is
// fine while there is ONE client — it is a private handshake between two files.
// The moment a second client speaks it (US-2504 AC2 asks iOS to "post the same
// multipart fields the web path sends"), an undocumented handshake becomes
// something the second client has to reverse-engineer out of page code, and a
// rename on either side silently breaks the client nobody was looking at.
//
// So: the names live here, both ends are asserted against them by
// src/test/video-grading-contract.test.ts, and a native client has a spec to
// implement rather than a page to read.
//
// This does NOT ship the iOS recorder. It is the seam that lets one be written
// without guessing.

/** The clip itself. Sent as a File/Blob part. */
export const VIDEO_FIELD = "video";

/**
 * "Grade FROM this clip", as opposed to merely attaching one as supplementary
 * evidence (US-1763). Sent as the exact string "true"; the server compares
 * against that literal, so "1", "TRUE" and true-ish values do NOT opt in.
 */
export const VIDEO_GRADING_FIELD = "video_grading";
export const VIDEO_GRADING_OPT_IN = "true";

/**
 * Optional guided-capture marks ("the front is at 0:03"). JSON. Never trusted by
 * the server: parsed and bounded against the clip's real duration, so a client
 * cannot claim a view it did not record.
 */
export const VIDEO_SLOT_MARKS_FIELD = "video_slot_marks";

/**
 * How the clip entered the app. Positive-only provenance: anything the server
 * does not recognise normalises to null rather than to a claim, so an
 * unrecognised value can never read as "recorded live".
 */
export const VIDEO_CAPTURE_SOURCE_FIELD = "video_capture_source";
export const VIDEO_CAPTURE_SOURCES = ["in_app_recorder", "library"] as const;
export type VideoCaptureSource = (typeof VIDEO_CAPTURE_SOURCES)[number];

/** Every field a clip submission may carry, for the contract test to walk. */
export const VIDEO_SUBMIT_FIELDS = [
  VIDEO_FIELD,
  VIDEO_GRADING_FIELD,
  VIDEO_SLOT_MARKS_FIELD,
  VIDEO_CAPTURE_SOURCE_FIELD,
] as const;

/**
 * What a client gets back when the clip yielded no usable required view.
 *
 * US-2504 AC3 describes this as "matching the web behaviour", which undersells
 * it: the guarantee is the SERVER's, not the page's. `failVideoGrading` in
 * routes/grade.ts returns BEFORE payment precedence runs and refunds a buyer
 * meter debit taken at the gate, so the submission lands retakeable and unpaid.
 *
 * That means ANY client posting this contract inherits the guarantee — iOS does
 * not have to implement it, and MUST NOT try to, because a client-side "don't
 * charge" is not a guarantee at all.
 */
export const VIDEO_ABSTAIN_STATUS = "needs_photos";

export interface VideoAbstainResponse {
  submissionId: string;
  status: typeof VIDEO_ABSTAIN_STATUS;
  videoGrading: { ok: false; reason: string };
  photo_requests: string[];
  payment: { paid: false; charged: false };
}

/** Whether a /api/grade/submit response is the abstain case. */
export function isVideoAbstain(body: unknown): body is VideoAbstainResponse {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const payment = b.payment as Record<string, unknown> | undefined;
  return (
    b.status === VIDEO_ABSTAIN_STATUS &&
    !!payment &&
    payment.charged === false
  );
}
