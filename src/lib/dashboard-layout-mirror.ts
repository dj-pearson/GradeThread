import type { DashboardSurface } from "@/lib/dashboard-widgets";

// The localStorage mirror of the last known dashboard layout, so the board
// paints its shape on the first frame instead of after the round trip.
//
// Keyed PER USER: a shared browser must never paint one seller's board for the
// next person who signs in, and sign-out clears every key under the prefix.
// Kept in its own module with no runtime imports because use-auth.ts calls
// clearLayoutMirrors(), and that file is in the entry chunk.

export const LAYOUT_MIRROR_PREFIX = "gt:dashboard-layout:";

export function layoutMirrorKey(userId: string, surface: DashboardSurface): string {
  return `${LAYOUT_MIRROR_PREFIX}${userId}:${surface}`;
}

/** The mirrored document, or null when there is none, no user, or no storage. */
export function readLayoutMirror(
  userId: string | null | undefined,
  surface: DashboardSurface,
): unknown {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(layoutMirrorKey(userId, surface));
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Store a layout document for this user. No user, no write. */
export function writeLayoutMirror(
  userId: string | null | undefined,
  surface: DashboardSurface,
  document: unknown,
): void {
  if (!userId) return;
  try {
    localStorage.setItem(layoutMirrorKey(userId, surface), JSON.stringify(document));
  } catch {
    /* private mode, quota, or no window; the server copy is the record */
  }
}

/** Remove every mirrored layout, for every user. Run on sign-out. */
export function clearLayoutMirrors(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LAYOUT_MIRROR_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* storage unavailable: nothing was mirrored either */
  }
}
