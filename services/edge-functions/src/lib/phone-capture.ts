// US-3161: the rules of a phone capture session, kept away from the routes.
//
// Everything here is pure so the limits can be tested without a stack. The
// limits are the feature: the phone holding the token is not signed in to
// anything, so a cap that lives in the page instead of the server is not a cap.

/** How long a scanned code is good for. Short on purpose. */
export const CAPTURE_TTL_MS = 15 * 60 * 1000;

/** Photos one session may add. Comfortably more than any one garment needs. */
export const CAPTURE_MAX_PHOTOS = 40;

/** Total bytes one session may add, across all of its photos. */
export const CAPTURE_MAX_BYTES = 200 * 1024 * 1024;

/** Per-photo ceiling. Matches the remote import core's. */
export const CAPTURE_MAX_PHOTO_BYTES = 15 * 1024 * 1024;

export const CAPTURE_TARGET_KINDS = ["item", "batch"] as const;
export type CaptureTargetKind = (typeof CAPTURE_TARGET_KINDS)[number];

export function isCaptureTargetKind(v: unknown): v is CaptureTargetKind {
  return typeof v === "string" && (CAPTURE_TARGET_KINDS as readonly string[]).includes(v);
}

/**
 * A fresh capture token: 32 random bytes, base64url.
 *
 * Deliberately NOT derived from the item id, the user id or the clock. A token
 * computed from something the seller's own pages already display would be
 * forgeable by anyone who ever saw that value.
 */
export function newCaptureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** sha-256 hex. What is stored, so a database read is not an upload credential. */
export async function hashCaptureToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A token as it arrives from a URL. Rejects anything that is not our shape. */
export function isWellFormedCaptureToken(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(raw);
}

/** The session as far as the rules care. */
export interface CaptureSessionState {
  expires_at: string;
  ended_at: string | null;
  photo_count: number;
  bytes_total: number;
}

export type CaptureRefusal =
  | { kind: "gone"; status: 410; error: string }
  | { kind: "full"; status: 429; error: string };

/**
 * Why this session cannot take another photo of `bytes`, or null if it can.
 *
 * Expiry and ending both answer 410 GONE rather than 401 or 403, and the
 * difference matters to the person holding the phone: 410 says "this code is
 * finished, get a new one", which is exactly what they should do, while a 403
 * reads as "you are not allowed" and sends them looking for a login.
 */
export function refuseCapture(
  session: CaptureSessionState,
  bytes: number,
  now: number = Date.now(),
): CaptureRefusal | null {
  if (session.ended_at) {
    return { kind: "gone", status: 410, error: "This code was finished on the computer." };
  }
  if (new Date(session.expires_at).getTime() <= now) {
    return { kind: "gone", status: 410, error: "This code has expired. Scan a new one." };
  }
  if (bytes > CAPTURE_MAX_PHOTO_BYTES) {
    return { kind: "full", status: 429, error: "That photo is too large." };
  }
  if (session.photo_count >= CAPTURE_MAX_PHOTOS) {
    return {
      kind: "full",
      status: 429,
      error: `That is ${CAPTURE_MAX_PHOTOS} photos, which is all one code takes.`,
    };
  }
  if (session.bytes_total + bytes > CAPTURE_MAX_BYTES) {
    return { kind: "full", status: 429, error: "This code has taken all the photos it can hold." };
  }
  return null;
}

/**
 * US-3162: which required shots this item still has no photo of.
 *
 * Takes both lists rather than reading either, so the required set stays the
 * grading gate's (REQUIRED_GRADING_PHOTO_TYPES) and this file stays pure. Order
 * is the required list's, because "front, back, tag" is the order a seller
 * shoots in and re-sorting it would read as a different instruction.
 *
 * Photo types are a fixed vocabulary shared by every seller, so naming the
 * missing ones tells the phone nothing about WHOSE item it is.
 */
export function missingPhotoTypes(
  required: readonly string[],
  present: readonly string[],
): string[] {
  const have = new Set(present.map((p) => p.toLowerCase()));
  return required.filter((t) => !have.has(t.toLowerCase()));
}

/** What the phone page needs to know, and nothing that identifies the seller. */
export interface CapturePublicView {
  photosTaken: number;
  photosLeft: number;
  expiresAt: string;
  targetKind: CaptureTargetKind;
  /** Required shots with no photo yet. Empty for a batch, which has no one item. */
  missingTypes: string[];
}

export function publicView(
  session: CaptureSessionState & { target_kind: string },
  missingTypes: readonly string[] = [],
): CapturePublicView {
  const kind = isCaptureTargetKind(session.target_kind) ? session.target_kind : "item";
  return {
    photosTaken: session.photo_count,
    photosLeft: Math.max(0, CAPTURE_MAX_PHOTOS - session.photo_count),
    expiresAt: session.expires_at,
    // The phone shows which shots are still missing for an item and a simple
    // counter for a batch. It is never told whose item it is.
    targetKind: kind,
    missingTypes: kind === "item" ? [...missingTypes] : [],
  };
}
