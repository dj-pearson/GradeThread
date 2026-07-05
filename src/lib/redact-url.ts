// US-1635: strip single-use auth/secret tokens from a URL before it reaches a
// third-party analytics store (GA page_location, PostHog $current_url).
//
// The branded confirm/recovery emails land on our own frontend with
// ?token_hash=…&type=… (and Supabase's implicit flow uses #access_token=…).
// token_hash is single-use but stays valid until verifyOtp consumes it, so if a
// pageview captures the full href it lands in analytics BEFORE consumption — a
// still-usable token in a place it should never be.
const SENSITIVE_QUERY_PARAMS = [
  "token_hash",
  "access_token",
  "refresh_token",
  "token",
  "code",
  "otp",
  "recovery_token",
  "confirmation_token",
];

/** Return `raw` with any sensitive auth params redacted (query + hash). */
export function redactSensitiveUrl(raw: string): string {
  try {
    const url = new URL(raw, "http://localhost");
    let changed = false;
    for (const p of SENSITIVE_QUERY_PARAMS) {
      if (url.searchParams.has(p)) {
        url.searchParams.set(p, "redacted");
        changed = true;
      }
    }
    // Supabase implicit flow puts tokens in the hash fragment.
    if (url.hash && /(access_token|refresh_token|token_hash)=/.test(url.hash)) {
      url.hash = "";
      changed = true;
    }
    if (!changed) return raw;
    // Preserve the original absolute/relative shape.
    return /^https?:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return raw;
  }
}

/**
 * Remove sensitive auth params ENTIRELY (vs redacting the value). Used by the
 * auth pages to scrub the visible address bar via history.replaceState once the
 * token has been read, so it doesn't linger in history / the Referer header / a
 * later SPA pageview. Returns whether anything changed so the caller can skip a
 * no-op replaceState.
 */
export function stripSensitiveParams(raw: string): { url: string; changed: boolean } {
  try {
    const url = new URL(raw, "http://localhost");
    let changed = false;
    for (const p of SENSITIVE_QUERY_PARAMS) {
      if (url.searchParams.has(p)) {
        url.searchParams.delete(p);
        changed = true;
      }
    }
    if (url.hash && /(access_token|refresh_token|token_hash)=/.test(url.hash)) {
      url.hash = "";
      changed = true;
    }
    const out = /^https?:\/\//i.test(raw)
      ? url.toString()
      : `${url.pathname}${url.search}${url.hash}`;
    return { url: out, changed };
  } catch {
    return { url: raw, changed: false };
  }
}
