// Storage path of a user's current avatar, parsed from its public URL, or null
// when the URL is not an object in that user's own folder of the `avatars`
// bucket. Deleting the previous avatar after a swap (so a photo the seller
// replaced does not stay publicly reachable) only ever touches a path this
// returns, so a hand-edited or foreign avatar_url can never point the delete
// at somebody else's object.
export function ownAvatarPath(
  avatarUrl: string | null | undefined,
  userId: string,
): string | null {
  if (!avatarUrl || !userId) return null;
  const marker = "/avatars/";
  const at = avatarUrl.indexOf(marker);
  if (at === -1) return null;
  const raw = avatarUrl.slice(at + marker.length).split(/[?#]/)[0] ?? "";
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!path.startsWith(`${userId}/`)) return null;
  // No climbing out of the folder, and no nested folder tricks.
  const rest = path.slice(userId.length + 1);
  if (!rest || rest.includes("/") || rest.includes("..")) return null;
  return path;
}

// The only types the avatar picker accepts. Everything is re-encoded on a
// canvas before upload, so this is about what the browser can DECODE (HEIC is
// transcoded first), not about what the bucket stores.
export const AVATAR_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif";

// Input size cap before re-encoding. The re-encoded 512px image is far below
// the bucket's 2 MB limit; this only stops a huge file from stalling the tab.
export const AVATAR_MAX_INPUT_BYTES = 20 * 1024 * 1024;
