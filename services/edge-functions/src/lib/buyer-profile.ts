// US-1818: buyer public profile — handle validation + PII-safe view assembly.
//
// PURE (unit-tested, no DB). The whole privacy posture lives here: a profile is
// private by default, and buildPublicProfile emits ONLY the stats the buyer
// explicitly opted into — an absent/false visibility key means the field never
// leaves the server. Handles are a constrained slug so they're safe in a URL and
// can't impersonate a system path.

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/; // 3–30 chars, no leading/trailing dash
const RESERVED_HANDLES = new Set([
  "admin", "api", "buyer", "trust", "verified", "cert", "grade", "settings", "me", "new", "profile",
]);

/**
 * Normalize + validate a public-profile handle. Lowercased; must be a 3–30 char
 * slug (letters/digits/dashes, no leading/trailing dash) and not a reserved word.
 * Returns null when invalid. Pure.
 */
export function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().toLowerCase();
  if (!HANDLE_RE.test(h)) return null;
  if (RESERVED_HANDLES.has(h)) return null;
  return h;
}

export interface ProfileVisibility {
  level: boolean;
  confirmations: boolean;
  member_since: boolean;
}

/** Coerce the stored/untrusted jsonb into a fully-populated visibility map. All
 *  fields default FALSE — private by construction. Pure. */
export function normalizeVisibility(raw: unknown): ProfileVisibility {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    level: r.level === true,
    confirmations: r.confirmations === true,
    member_since: r.member_since === true,
  };
}

export interface ProfileSource {
  handle: string;
  displayName: string;
  level: number;
  levelLabel: string;
  memberSince: string | null;
  confirmations: number;
}

export interface PublicProfile {
  handle: string;
  displayName: string;
  level?: number;
  levelLabel?: string;
  confirmations?: number;
  memberSince?: string | null;
}

/**
 * Assemble the PUBLIC profile view, including ONLY the opted-in stats. The handle
 * + a display name are always present (they ARE the public identity); every other
 * field appears only when its visibility flag is true. Pure — the single
 * chokepoint that guarantees an un-opted stat never reaches the response.
 */
export function buildPublicProfile(src: ProfileSource, vis: ProfileVisibility): PublicProfile {
  const out: PublicProfile = { handle: src.handle, displayName: src.displayName };
  if (vis.level) {
    out.level = src.level;
    out.levelLabel = src.levelLabel;
  }
  if (vis.confirmations) out.confirmations = src.confirmations;
  if (vis.member_since) out.memberSince = src.memberSince;
  return out;
}
