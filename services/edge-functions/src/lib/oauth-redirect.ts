// Same-origin redirect sanitizer for the eBay OAuth flow (US-274, hardened
// US-361). Kept side-effect-free (no supabase/eBay imports) so it can be
// unit-tested in isolation and reused by any OAuth bounce-back.

// In-app destinations the OAuth callback may bounce back to. The web flow lands
// the user inside the dashboard (FlipDesk marketplaces); the iOS app (US-661)
// bounces back through an https Universal Link under `/app/*` that the app
// claims via its associated-domains entitlement (AASA at
// /.well-known/apple-app-site-association). Both are same-origin relative paths
// on gradethread.com — anything outside this allowlist is dropped to the safe
// default so a crafted ?redirect_to= can't drive an open redirect.
export const ALLOWED_REDIRECT_PREFIXES = ["/dashboard", "/app"];

// Only same-origin relative redirects under a known prefix are allowed back out
// of the OAuth callback — prevents an open redirect via a crafted ?redirect_to=.
// Rejects, in order:
//   - control chars incl. tab/newline/CR (browsers STRIP these, so "/\t/evil.com"
//     would otherwise collapse to a protocol-relative "//evil.com");
//   - anything not starting with a single "/" (absolute/scheme URLs included);
//   - "//host" (protocol-relative);
//   - any backslash anywhere ("/\host", "\" — browsers treat "\" as "/");
//   - any path whose route is not in ALLOWED_REDIRECT_PREFIXES.
export function sanitizeRelativePath(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  // Control chars (NUL..US + DEL), incl. \t \n \r.
  // deno-lint-ignore no-control-regex -- matching control chars is the intent.
  if (/[\u0000-\u001F\u007F]/.test(input)) return null;
  if (!input.startsWith("/")) return null;
  if (input.startsWith("//")) return null;
  if (input.includes("\\")) return null;
  // Compare on the path portion only (ignore ?query / #fragment).
  const path = input.split(/[?#]/, 1)[0]!;
  const allowed = ALLOWED_REDIRECT_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
  return allowed ? input : null;
}
