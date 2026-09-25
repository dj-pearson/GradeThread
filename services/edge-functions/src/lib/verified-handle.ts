// The Verified handle format, shared by everything on the edge that accepts
// one: the profile routes (claiming a handle) and badge-click attribution
// (resolving one). Keeping it in one place means a click can never resolve a
// handle the profile routes would refuse to store.
//
// 3-30 chars, lowercase alnum + hyphen, no leading/trailing hyphen. Mirrors the
// DB CHECK constraint (migration 00057) and the client-side validation in
// src/lib/verified.ts.
export const HANDLE_RE = /^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$/;

/**
 * The canonical (lowercased, trimmed) form of a handle, or null when it is not
 * a valid handle at all. Stored handles are always canonical, so this is what
 * every lookup, stored id and dedupe key should use.
 */
export function canonicalHandle(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  return HANDLE_RE.test(h) ? h : null;
}
