// US-2669: the composer's eye toggle — hide a photo from every marketplace
// without deleting it.
//
// WHY THIS IS A TAG CHANGE AND NOT A NEW COLUMN. `internal` already means
// exactly "stays on the item, never sent to eBay, never fed to a generation AI,
// never shown on a public surface" (US-1549), and every selection site in the
// edge already drops it via filterListablePhotos. A second boolean would be a
// second thing those filters could disagree with. The eye writes the tag the
// filters already honour, so it is enforced the moment it is set — no migration,
// and no second rule for the other clients to learn.
//
// `is_hidden` was NOT reused on purpose: it is the admin moderation marker
// (US-889, migration 00213) whose unhide path is an audited operator endpoint.
// A seller toggling it would be un-hiding moderator-hidden content.
//
// THE ONE THING A TAG CHANGE LOSES is what the photo was tagged as before, and
// a toggle you cannot un-toggle back to where you were is not a toggle. So the
// old tag is remembered in `photo_role`, which is deliberately open text with no
// CHECK constraint (US-2462) and which `internal` otherwise leaves unused —
// `rolesForType('internal')` returns nothing, so there is no real role to
// collide with. Every non-listable rule keys on the TYPE, so a memo role cannot
// make a hidden photo listable by accident.

import { FLIPDESK_PHOTO_TYPES } from "@/lib/constants";
import type { FlipdeskPhotoType } from "@/types/database";

/** The tag a photo falls back to when un-hidden with nothing remembered. */
export const RESTORE_FALLBACK_TYPE: FlipdeskPhotoType = "angle";

const MEMO_PREFIX = "was:";

/** True when this photo is held back from every marketplace by the eye toggle. */
export function isHiddenFromListing(
  photoType?: string | null,
): boolean {
  return (photoType ?? "") === "internal";
}

/** True when `photo_role` is a remembered tag rather than a real qualifier. */
export function isTagMemo(photoRole?: string | null): boolean {
  return (photoRole ?? "").startsWith(MEMO_PREFIX);
}

/** Encode the tag a photo carried before it was hidden. */
export function encodeTagMemo(
  photoType: string,
  photoRole?: string | null,
): string {
  return photoRole
    ? `${MEMO_PREFIX}${photoType}/${photoRole}`
    : `${MEMO_PREFIX}${photoType}`;
}

/**
 * Decode a remembered tag, or null when there is nothing to decode — no memo,
 * or a memo naming a type this build no longer knows.
 */
export function decodeTagMemo(
  photoRole?: string | null,
): { type: FlipdeskPhotoType; role: string | null } | null {
  if (!isTagMemo(photoRole)) return null;
  const body = (photoRole as string).slice(MEMO_PREFIX.length);
  if (!body) return null;
  const i = body.indexOf("/");
  const type = i === -1 ? body : body.slice(0, i);
  const role = i === -1 ? null : body.slice(i + 1) || null;
  // A memo is written by an older build than the one reading it, sooner or
  // later. Refuse an unknown type rather than write it back onto the row, where
  // the enum would reject it and the un-hide would fail with a 400.
  if (!(FLIPDESK_PHOTO_TYPES as readonly string[]).includes(type)) return null;
  // Never restore INTO hidden: a memo of 'internal' would make the eye a no-op.
  if (type === "internal") return null;
  return { type: type as FlipdeskPhotoType, role };
}

/** The (type, role) pair that hides a photo, remembering what it was. */
export function hideTag(
  photoType: string,
  photoRole?: string | null,
): { type: FlipdeskPhotoType; role: string | null } {
  return {
    type: "internal",
    // Hiding an already-hidden photo must not overwrite the memo with a memo of
    // 'internal' — the restore target would be lost on a double-click.
    role: isHiddenFromListing(photoType)
      ? (photoRole ?? null)
      : encodeTagMemo(photoType, photoRole),
  };
}

/**
 * The (type, role) pair that un-hides a photo.
 *
 * With no memo — a photo tagged "Internal (not listed)" by hand, or before this
 * toggle existed — it lands on a neutral listable tag rather than guessing. The
 * seller retags from there; the point is that the photo is back in the listing.
 */
export function showTag(
  photoRole?: string | null,
): { type: FlipdeskPhotoType; role: string | null } {
  return decodeTagMemo(photoRole) ?? { type: RESTORE_FALLBACK_TYPE, role: null };
}
