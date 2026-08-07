// Walk-around video capture — the client's half of US-1762.
//
// Pure constants + the guided-capture prompt list, kept out of the component so
// the submit path and any future surface (iOS/Android parity, the Snap flow)
// read the SAME caps the edge enforces. These MIRROR the server:
//   MAX_VIDEO_BYTES / MAX_VIDEO_DURATION_SECONDS  → routes/grade.ts
//   VIDEO_SLOT_PROMPTS keys                       → REQUIRED_VIDEO_FRAME_SLOTS
//                                                   in lib/video-frames.ts
// The client copy exists to fail fast and explain, never to be the gate: the
// server re-validates the bytes, the duration and every mark regardless.

/** Mirrors MAX_VIDEO_BYTES in services/edge-functions/src/routes/grade.ts. */
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

/** Mirrors MAX_VIDEO_DURATION_SECONDS in the same file. */
export const MAX_VIDEO_DURATION_SECONDS = 45;

/** The container formats validateVideoUpload accepts (magic-byte sniffed). */
export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm";

/**
 * The views a walk-around must contain. Same four as REQUIRED_VIDEO_FRAME_SLOTS
 * server-side, and the same bar the photo path enforces — a video submission
 * clears exactly the same coverage requirement, it just gets there in one take.
 */
export const VIDEO_SLOT_KEYS = ["front", "back", "label", "detail"] as const;

export type VideoSlotKey = (typeof VIDEO_SLOT_KEYS)[number];

/** Seller-tapped timestamps (seconds into the clip) per view. All optional. */
export type VideoSlotMarks = Partial<Record<VideoSlotKey, number>>;

export interface VideoSlotPrompt {
  key: VideoSlotKey;
  label: string;
  hint: string;
}

export const VIDEO_SLOT_PROMPTS: readonly VideoSlotPrompt[] = [
  {
    key: "front",
    label: "Front",
    hint: "The whole front of the item, edge to edge.",
  },
  {
    key: "back",
    label: "Back",
    hint: "The whole back, same distance as the front.",
  },
  {
    key: "label",
    label: "Brand / care tag",
    hint: "Hold the tag steady and close enough to read.",
  },
  {
    key: "detail",
    label: "Fabric close-up",
    hint: "The weave or knit up close — not a defect shot.",
  },
];

// ── Clip provenance (US-1766) ────────────────────────────────────────────────
//
// How the clip entered the app. Mirrors IN_APP_VIDEO_CAPTURE_SOURCE /
// LIBRARY_VIDEO_CAPTURE_SOURCE in services/edge-functions/src/lib/
// verified-capture.ts, which re-normalizes whatever we send: an unrecognized
// string becomes null there, so a stale client can never assert "live".

/** Recorded live in the in-app recorder, straight off the camera stream. */
export const IN_APP_VIDEO_CAPTURE_SOURCE = "in_app_recorder";

/** An existing file the seller picked from the device. */
export const LIBRARY_VIDEO_CAPTURE_SOURCE = "library";

export type VideoCaptureSource =
  | typeof IN_APP_VIDEO_CAPTURE_SOURCE
  | typeof LIBRARY_VIDEO_CAPTURE_SOURCE;

/**
 * MediaRecorder container candidates, best first. Every entry must be a format
 * `validateVideoUpload` sniffs (mp4 / quicktime / webm) — a recording the server
 * then rejects is worse than no recorder at all. Safari records mp4; Chrome and
 * Firefox record webm.
 */
export const RECORDER_MIME_CANDIDATES = [
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/**
 * First candidate the browser can actually record, or null when none is
 * supported (which is the signal to hide the recorder and offer the picker).
 * `isSupported` is injected so this stays pure and testable.
 */
export function pickRecorderMimeType(
  isSupported: (type: string) => boolean,
): string | null {
  for (const type of RECORDER_MIME_CANDIDATES) {
    try {
      if (isSupported(type)) return type;
    } catch {
      // A browser whose isTypeSupported throws is a browser that can't record it.
    }
  }
  return null;
}

/**
 * File extension for a recorded blob's mime type. The edge sniffs magic bytes
 * and ignores the name, so this is only for the seller's benefit — but a clip
 * called `.webm` that is really mp4 is a support ticket waiting to happen.
 */
export function recordedClipExtension(mimeType: string): "mp4" | "webm" {
  return mimeType.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

/** Stable, human-readable name for a clip recorded in-app. */
export function recordedClipName(mimeType: string): string {
  return `walk-around.${recordedClipExtension(mimeType)}`;
}

/**
 * The mid-point of a recorded segment, in seconds, rounded to 2dp — the frame
 * most likely to actually show the view, rather than the hand-off blur at
 * either end. Returns null for a segment too short to sample.
 */
export function segmentMarkSeconds(
  startSeconds: number,
  endSeconds: number,
): number | null {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;
  if (endSeconds <= startSeconds) return null;
  return Number(((startSeconds + endSeconds) / 2).toFixed(2));
}

/** Drop empty/non-finite marks so an untouched slot is simply absent. */
export function serializeVideoSlotMarks(marks: VideoSlotMarks): string {
  const clean: Record<string, number> = {};
  for (const key of VIDEO_SLOT_KEYS) {
    const v = marks[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      clean[key] = Number(v.toFixed(2));
    }
  }
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : "";
}
