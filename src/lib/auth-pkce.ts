// GT-001: telling a cross-device confirmation link apart from a slow one.
//
// The client runs the PKCE flow (src/lib/supabase.ts). When GoTrue's own email
// template sends the confirmation, its link resolves to our emailRedirectTo
// carrying `?code=…`, and supabase-js exchanges that code using a VERIFIER it
// stored in this browser at signUp time. A person who signs up on a laptop and
// opens the mail on their phone has the code and not the verifier, so the
// exchange cannot succeed on any timescale.
//
// Before this, that case was indistinguishable from a slow network: the callback
// spun for fifteen seconds and then said "Sign-in is taking longer than
// expected. Please try signing in again." Trying again produces the same
// nothing, because the problem is the device, not the attempt.
//
// The branded hook (routes/auth-hooks.ts) sends a token_hash link at
// /auth/confirm plus a 6-digit code, and neither needs the verifier — so with
// the hook configured this path is not reached at all. It exists for the deploy
// where the hook is off, which is invisible from the browser.

/** supabase-js stores the verifier at `${storageKey}-code-verifier`. */
const VERIFIER_SUFFIX = "-code-verifier";

function scan(store: Storage | undefined): boolean {
  if (!store) return false;
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || !key.endsWith(VERIFIER_SUFFIX)) continue;
    const value = store.getItem(key);
    if (value && value.length > 0) return true;
  }
  return false;
}

/**
 * Does THIS browser hold a PKCE code verifier?
 *
 * Deliberately scans for the suffix rather than rebuilding the storage key from
 * the Supabase URL: the key embeds the project ref, which on a self-hosted
 * domain is the first host label (`api`), and a key we compute wrongly would
 * report "no verifier" for everybody and send every user down the recovery path.
 * Both stores are checked because the "shared device" preference routes the
 * session to sessionStorage (see hybridStorage).
 */
export function hasPkceVerifier(): boolean {
  try {
    return scan(window.localStorage) || scan(window.sessionStorage);
  } catch {
    // Storage blocked entirely (private mode, cookie policy). The verifier could
    // not have been written either, so a code cannot be exchanged here — same
    // outcome as a missing one, and the recovery path is the right destination.
    return false;
  }
}

/**
 * A callback URL that carries an authorization code this browser cannot spend.
 *
 * Both halves matter: no `code` means this is an OAuth/implicit landing rather
 * than an email confirmation, and a present verifier means the exchange is
 * merely in flight.
 */
export function isCrossDeviceConfirmation(search: string): boolean {
  return new URLSearchParams(search).has("code") && !hasPkceVerifier();
}
