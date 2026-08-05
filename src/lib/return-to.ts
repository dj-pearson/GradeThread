// US-1430: preserve the page a user was trying to reach through the login
// redirect, without opening an open-redirect hole.
//
// ProtectedRoute bounces an unauthenticated deep-link to `/login?next=<path>`;
// LoginPage / the OAuth callback then send the user to that path after sign-in.
// Because `next` is attacker-controllable (it rides in the URL, and the OAuth
// hop stashes it in sessionStorage), it MUST be validated to be a same-origin
// INTERNAL path before we navigate to it — otherwise `?next=//evil.com` or
// `?next=https://evil.com` would bounce a freshly-authenticated user off-site.

/** sessionStorage key the OAuth hop uses to carry the return-to across the
 *  external provider round-trip (the `?next=` query param is lost there). */
export const RETURN_TO_KEY = "gt_return_to";

/**
 * Return `raw` only if it is a safe internal path to navigate to after sign-in,
 * else null (caller falls back to /dashboard). Accepts a single absolute path
 * with optional query/hash; rejects scheme-relative (`//host`), backslash
 * tricks (`/\host`), absolute URLs, control characters, and auth surfaces
 * (which would loop or skip the app).
 */
export function sanitizeReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  // Must be an absolute internal path…
  if (!value.startsWith("/")) return null;
  // …but not protocol-relative ("//evil.com") or a backslash variant browsers
  // normalize to one ("/\\evil.com"), nor an encoded slash that decodes to one.
  if (
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    value.startsWith("/%2F") ||
    value.startsWith("/%5C")
  ) {
    return null;
  }
  // No control chars (newlines/tabs can smuggle past naive checks).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  // Never bounce back into an auth surface — that would loop the user through
  // login or skip the dashboard landing.
  const pathOnly = value.split(/[?#]/)[0] ?? value;
  if (
    pathOnly === "/login" ||
    pathOnly === "/signup" ||
    pathOnly.startsWith("/auth/")
  ) {
    return null;
  }
  return value;
}

/**
 * US-1925: validate an attacker-suppliable URL param used in the white-label
 * grade embed (`?support=`, `?logo=`). The embed URL is fully craftable by a
 * third party, so a GradeThread-hosted card must not carry a `javascript:` /
 * `data:` payload or a phishing link that borrows our domain's legitimacy.
 * Accept ONLY an absolute `https://` URL; reject dangerous schemes, `http:`
 * downgrades, protocol-relative (`//host`) and relative refs, and anything
 * unparseable. Returns the normalized href, or null so the caller omits the
 * link / image.
 *
 * A partner-host allowlist is deliberately NOT applied: the embed is open
 * white-label, so support/logo are legitimately partner-hosted on arbitrary
 * domains. The enforceable invariant is the scheme — https blocks the
 * executable / off-site-redirecting vectors, while a broken image or an omitted
 * link is the worst case for an otherwise-valid but unwanted host.
 */
export function safeEmbedUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null; // relative / protocol-relative / malformed → not an absolute URL
  }
  return url.protocol === "https:" ? url.href : null;
}
