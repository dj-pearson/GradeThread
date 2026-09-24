// AL-03: where the workbench's session id and its localStorage mirror come
// from, scoped to one (user, workspace owner) pair.
//
// The session id used to live under one unscoped `autolister:sessionId` key
// that survived sign-out and workspace switches, so the next person to sign in
// on a shared computer rehydrated the last one's staged grid.
import {
  autolisterSessionKey,
  scopeSessionToOwner,
} from "@/lib/autolister-session-idb";
import { readStored, removeStored, writeStored } from "@/lib/safe-storage";

/** The unscoped key every browser used before AL-03. Adopted once, then removed. */
export const LEGACY_SESSION_KEY = "autolister:sessionId";

/**
 * This user's session id for this workspace, minting one when there is none.
 * Runs during render, so it never throws (US-3218): blocked storage costs a
 * resumed session at most.
 */
export function readWorkbenchSessionId(
  userId: string | null | undefined,
  ownerId: string | null | undefined,
): { sessionId: string; sessionKey: string | null } {
  const sessionKey = userId && ownerId ? autolisterSessionKey(userId, ownerId) : null;
  const existing = sessionKey ? readStored(sessionKey) : null;
  if (existing) return { sessionId: existing, sessionKey };
  // The pre-AL-03 key's IDB row carries no owner stamp, so the rehydrate
  // filters it to this owner's staging folder and does not resume its files.
  const legacy = readStored(LEGACY_SESSION_KEY);
  removeStored(LEGACY_SESSION_KEY);
  const sessionId = legacy ?? crypto.randomUUID();
  if (sessionKey) writeStored(sessionKey, sessionId);
  return { sessionId, sessionKey };
}

/**
 * The localStorage mirror of a session (first paint, and the whole store when
 * IndexedDB is unavailable), filtered to `ownerId`'s own staged photos.
 */
export function readLocalWorkbenchSession<P, G>(
  storageKey: string,
  ownerId: string | null | undefined,
): { staged: P[]; groups: G[] } {
  const empty = { staged: [] as P[], groups: [] as G[] };
  if (typeof window === "undefined" || !ownerId) return empty;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as { staged?: unknown[]; groups?: unknown[] };
    const scoped = scopeSessionToOwner(
      {
        staged: Array.isArray(parsed.staged) ? parsed.staged : [],
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        updatedAt: 0,
        ownerId,
      },
      ownerId,
    ).session;
    return scoped ? { staged: scoped.staged as P[], groups: scoped.groups as G[] } : empty;
  } catch {
    return empty;
  }
}
