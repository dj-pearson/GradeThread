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
