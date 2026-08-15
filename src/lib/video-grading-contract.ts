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

// ── What the SUBMIT route will actually accept (US-2504 slice 2) ────
//
// A recorder has to be built to these or it produces clips the server refuses,
// and the refusal arrives after the whole upload. None of it was written down.
//
// ⚠ THE NUMBERS THAT APPLY ARE THE ROUTE'S, NOT THE VALIDATION LIBRARY'S, AND
// THEY DIFFER. `lib/video-validation.ts` defaults to 100 MB / 60s, and
// `routes/grade.ts` passes its own stricter caps — so a client built by reading
// the validator gets rejections at sizes the validator says are fine. The
// validator's defaults serve other callers; these are the grading path's.

/** Hard cap on the uploaded clip, in bytes. `routes/grade.ts` MAX_VIDEO_BYTES. */
export const VIDEO_SUBMIT_MAX_BYTES = 60 * 1024 * 1024;

/** Hard cap on clip length. `routes/grade.ts` MAX_VIDEO_DURATION_SECONDS. */
export const VIDEO_SUBMIT_MAX_DURATION_SECONDS = 45;

/**
 * Containers the sniffer accepts. Detected from MAGIC BYTES, not the filename
 * or the declared MIME type, so naming a file .mp4 does not make it one.
 */
export const VIDEO_SUBMIT_FORMATS = ["mp4", "mov", "webm"] as const;
export type VideoSubmitFormat = (typeof VIDEO_SUBMIT_FORMATS)[number];

/**
 * The clip's duration must be READABLE from the container, and this rejects
 * more clips than it sounds like it should.
 *
 * The frame plan samples by timestamp, so a clip whose length cannot be parsed
 * gives the server nowhere to look — it is refused before a submission row or a
 * charge exists. An export preset that produces a container without a readable
 * duration therefore fails every time, with a message about the clip rather
 * than about the preset.
 */
export const VIDEO_DURATION_MUST_BE_READABLE = true;

/**
 * Photos and a clip in the same submission are REFUSED (`videoPhotoConflict`).
 *
 * This is the rule a second client is most likely to break, because the natural
 * iOS flow is additive: the seller stages photos, then records a walk-around as
 * well, and sending both feels like sending more evidence. It is a 400.
 *
 * Two reasons, and both matter more than the convenience. The pipeline makes one
 * Vision call per image, so accepting both stacks the 14-slot photo cap on top
 * of the frame cap for one grade's revenue, with nothing bounding the request.
 * And it voids the claim the feature is sold on — that every graded view came
 * from one continuous take.
 *
 * So the client must make it a MODE, not an addition: choosing video clears
 * staged photos, and choosing photos clears the clip.
 */
export const VIDEO_EXCLUDES_PHOTOS = true;

/**
 * ⚠ 100% UPLOADED IS NOT 100% DONE, and a progress bar that treats it as done
 * is the exact failure AC4 exists to prevent, one step later.
 *
 * Frame extraction and grading run AFTER the last byte lands, and the server
 * sends no progress for that phase. The web path (`new-submission.tsx`
 * `postSubmission`) holds the bar at 100 and lets the copy carry the rest.
 *
 * A client that dismisses the sheet at 100, or swaps to a "done" state, tells
 * the seller their grade is ready while the server has not started. The honest
 * shape is: determinate bar to 100 on upload, then an indeterminate "grading"
 * state until the response arrives.
 */
export const VIDEO_UPLOAD_COMPLETE_IS_NOT_GRADED = true;

/** Why a clip would be refused before upload, or null if it looks acceptable. */
export function videoSubmitRejection(clip: {
  bytes: number;
  durationSeconds: number | null;
  format: string;
  stagedPhotoCount: number;
}): string | null {
  if (clip.stagedPhotoCount > 0) {
    return "Video grading grades the clip's own frames, so photos can't be included too.";
  }
  if (clip.bytes <= 0) return "That clip is empty.";
  if (clip.bytes > VIDEO_SUBMIT_MAX_BYTES) {
    return `That clip is too large (max ${Math.round(VIDEO_SUBMIT_MAX_BYTES / (1024 * 1024))} MB).`;
  }
  if (!(VIDEO_SUBMIT_FORMATS as readonly string[]).includes(clip.format)) {
    return "That video format can't be graded.";
  }
  // Null duration is caught SERVER-side, but a client that can read it should
  // say so before spending the upload.
  if (clip.durationSeconds !== null && !(clip.durationSeconds > 0)) {
    return "That clip's length could not be read, so it can't be graded.";
  }
  if (
    clip.durationSeconds !== null &&
    clip.durationSeconds > VIDEO_SUBMIT_MAX_DURATION_SECONDS
  ) {
    return `That clip is too long (max ${VIDEO_SUBMIT_MAX_DURATION_SECONDS} seconds).`;
  }
  return null;
}
