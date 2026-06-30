import { supabase } from "@/lib/supabase";

// Token freshness helpers shared by every edge-call path (edgeFetch,
// edgeAuthHeaders, the legacy use-ebay authHeader).
//
// Why this exists: supabase-js auto-refreshes the access token on a background
// timer, but that timer is SUSPENDED while the browser tab is backgrounded or
// the device is asleep. After idle, `getSession()` can hand back an
// already-expired (or about-to-expire) token, which the edge then rejects with
// a 401 — surfacing to the user as "session expired" even though their refresh
// token is still perfectly valid. Access tokens live 1h (GOTRUE_JWT_EXP=3600),
// so this bites almost exactly at the 1-hour mark.
//
// We close the gap two ways, mirroring the iOS US-1146 behavior:
//   1. getFreshAccessToken() refreshes PROACTIVELY when the stored token is at
//      or near expiry, so we rarely send a dead token in the first place.
//   2. forceRefreshAccessToken() backs the edgeFetch 401-retry: if the server
//      still rejects a token that looked fresh (clock skew, rotation), refresh
//      once and retry before giving up.

// Refresh when the token expires within this margin (seconds) — or already has.
// Generous enough to cover a slow network round-trip before the token lapses.
const EXPIRY_MARGIN_SECONDS = 60;

/**
 * Returns a usable access token for the current session, refreshing first when
 * the stored token is at/near expiry. Returns null when there is no session
 * (caller treats that as "not signed in"). On a refresh failure we fall back to
 * the existing token rather than hard-failing — the server may still accept it,
 * and the 401-retry path is the real backstop.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  const expiresAt = session.expires_at; // unix seconds, may be undefined
  const nearExpiry =
    typeof expiresAt === "number" &&
    expiresAt - Math.floor(Date.now() / 1000) <= EXPIRY_MARGIN_SECONDS;
  if (!nearExpiry) return session.access_token;

  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session?.access_token) return session.access_token;
  return data.session.access_token;
}

/**
 * Forces a token refresh and returns the new access token, or null when there's
 * no session to refresh or the refresh fails. Used by the edgeFetch 401-retry
 * after the server actively rejects a token.
 */
export async function forceRefreshAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session?.access_token) return null;
  return data.session.access_token;
}
