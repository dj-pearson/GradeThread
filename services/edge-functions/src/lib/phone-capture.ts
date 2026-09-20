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

/**
 * What a code can be FOR. Nothing is ever written through the target: the
 * desktop polls its own session under an owner filter and decides where the
 * photos go, so this says what the seller asked for rather than granting the
 * token reach.
 *
 * `staging` is US-3185's: AutoLister photo intake has no
 * `listing_generation_batches` row to bind to, because that row is created
 * when generation STARTS, which is after the photos exist and have been
 * grouped into items. A capture started from the intake page binds to the
 * seller's own AutoLister session id instead.
 */
export const CAPTURE_TARGET_KINDS = ["item", "batch", "staging"] as const;
export type CaptureTargetKind = (typeof CAPTURE_TARGET_KINDS)[number];

export function isCaptureTargetKind(v: unknown): v is CaptureTargetKind {
  return typeof v === "string" && (CAPTURE_TARGET_KINDS as readonly string[]).includes(v);
}

/**
 * US-3185: how many items one code may carry.
 *
 * Equal to the photo cap, because an item with no photo is not an item: the
 * boundary only moves once the current one has a shot on it, so the group
 * index can never outrun the photo count.
 */
export const CAPTURE_MAX_GROUPS = CAPTURE_MAX_PHOTOS;

/**
 * Does this code shoot several items, or one?
 *
 * An item capture is bound to a row that already exists and has a required
 * shot list; a batch or staging capture is a bin the seller walks through, so
 * it gets the "Next item" control and no missing-shot prompt.
 */
export function isMultiItemCapture(kind: CaptureTargetKind): boolean {
  return kind !== "item";
}

/**
 * The group index after a "Next item" tap, given where the phone is now.
 *
 * TWO REFUSALS, both returning the CURRENT index rather than an error, because
 * the person holding the phone did nothing wrong and a sentence about it would
 * be noise:
 *
 *   • An EMPTY group does not advance. Two taps in a row, or a tap before the
 *     first shot, would otherwise leave an item with no photos in it, and the
 *     desktop would build an empty group the seller has to delete.
 *   • The LAST group does not advance. `CAPTURE_MAX_GROUPS` is the ceiling and
 *     running past it would file shots under an item that cannot exist.
 *
 * The phone never sends an index of its own — it can only ask to advance — so
 * this is the whole of what a tampered page could do to the grouping.
 */
export function nextGroupIndex(
  current: number,
  photosInCurrentGroup: number,
  max: number = CAPTURE_MAX_GROUPS,
): number {
  if (!Number.isInteger(current) || current < 0) return 0;
  if (photosInCurrentGroup <= 0) return current;
  if (current + 1 >= max) return current;
  return current + 1;
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
  /** US-3185: the item the phone is shooting now. 0 for a single-item code. */
  group_index?: number;
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
  /** US-3185: which item of the bin the phone is on. Always 0 for an item code. */
  groupIndex: number;
  /** Shots on the current item, so the phone can refuse an empty "Next item". */
  photosInGroup: number;
  /** Whether this code walks a bin, and therefore shows a "Next item" control. */
  multiItem: boolean;
}

export function publicView(
  session: CaptureSessionState & { target_kind: string },
  missingTypes: readonly string[] = [],
  photosInGroup = 0,
): CapturePublicView {
  const kind = isCaptureTargetKind(session.target_kind) ? session.target_kind : "item";
  const multiItem = isMultiItemCapture(kind);
  const stored = session.group_index;
  const group = multiItem && Number.isInteger(stored) && (stored as number) >= 0
    ? stored as number
    : 0;
  return {
    photosTaken: session.photo_count,
    photosLeft: Math.max(0, CAPTURE_MAX_PHOTOS - session.photo_count),
    expiresAt: session.expires_at,
    // The phone shows which shots are still missing for an item and a simple
    // counter for a batch. It is never told whose item it is.
    targetKind: kind,
    missingTypes: kind === "item" ? [...missingTypes] : [],
    // US-3185: an item code has exactly one group and no boundary control, so
    // it reports 0 whatever the row says rather than exposing a counter the
    // phone has no way to move.
    groupIndex: group,
    photosInGroup: multiItem ? Math.max(0, photosInGroup) : session.photo_count,
    multiItem,
  };
}
