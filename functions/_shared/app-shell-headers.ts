// US-2330: security headers for the SPA SHELL, which had none.
//
// THE DEFECT. `serveSpaShell` builds a fresh Response and copies only
// content-type, cache-control and x-robots-tag. Cloudflare `_headers` does not
// apply to Pages Function responses, so every route served by a Function —
// /login, /signup, /dashboard/*, /admin/*, the whole authenticated surface —
// shipped with no CSP, no HSTS, no X-Frame-Options, no X-Content-Type-Options,
// no Referrer-Policy and no Permissions-Policy. Verified live, not inferred.
//
// ⚠ WHY NOT `ssrSecurityHeaders()`, which the story's AC1 asked for. That helper
// was purpose-built for standalone SSR content pages and says so in its own
// header: "these pages do NOT mount the SPA, so their CSP is much tighter". Using
// it here breaks the app four ways, and every one is a regression this repo has
// already had and documented in public/_headers:
//
//   1. Its script-src/connect-src omit Stripe, PostHog, Sentry, Turnstile,
//      Cloudflare Insights and the Google Ads origins the SPA loads. Checkout,
//      error reporting and analytics all stop.
//   2. It sets Cross-Origin-Opener-Policy: same-origin. public/_headers
//      deliberately uses same-origin-allow-popups, because bare same-origin
//      severs the window handle so popup.close() silently no-ops and the Google
//      Photos picker and the Stripe/eBay/Google OAuth popups are left open for
//      the user to close by hand.
//   3. Its script-src is nonce-based. The shell is a PREBUILT index.html whose
//      inline head script is allowed by a sha256 hash — there is no nonce to
//      stamp on a static file, so the Consent Mode / font / GA bootstrap would
//      be blocked.
//   4. It sets no Permissions-Policy. public/_headers carries camera=(self)
//      precisely because shipping camera=() once made getUserMedia reject in
//      production and silently broke both the grading photo capture and the
//      barcode scanner.
//
// So the shell emits the SAME set public/_headers already defines for static
// responses. That set is tuned, and it survived the COOP, camera and inline-hash
// incidents. Two header sets exist because two surfaces genuinely differ;
// collapsing them onto the tighter one is the bug, not the fix.

/**
 * The app-shell CSP, directive by directive, WITHOUT the inline-script hash —
 * that is computed per response from the shell HTML itself (see
 * {@link inlineBootstrapHash}), which is why this file needs no build step to
 * stay in sync with the bootstrap.
 *
 * Kept token-identical to the `/*` block in public/_headers. A vitest guard
 * (src/test/app-shell-headers-parity.test.ts) fails if the two drift, because
 * two copies of a CSP is exactly how an origin gets added to one and not the
 * other — which presents as a feature that works on marketing pages and breaks
 * once you sign in.
 */
export const APP_SHELL_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  // `__HASH__` is replaced with the bootstrap's sha256 token per response.
  "script-src 'self' 'wasm-unsafe-eval' '__HASH__' https://js.stripe.com https://www.googletagmanager.com https://googleads.g.doubleclick.net https://www.googleadservices.com https://us-assets.i.posthog.com https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://gradethread.com https://*.gradethread.com https://*.googleusercontent.com https://*.ebayimg.com https://*.ebaystatic.com https://*.stripe.com https://www.googletagmanager.com https://*.google-analytics.com https://*.g.doubleclick.net https://pagead2.googlesyndication.com https://www.google.com",
  "media-src 'self' blob:",
  "font-src 'self' https://fonts.gstatic.com data:",
  "connect-src 'self' https://api.gradethread.com wss://api.gradethread.com https://functions.gradethread.com https://staticimgly.com https://*.ebayimg.com https://*.stripe.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://us.i.posthog.com https://us-assets.i.posthog.com https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://cloudflareinsights.com https://challenges.cloudflare.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://ad.doubleclick.net https://www.google.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "report-uri /csp-report",
  "report-to csp-endpoint",
];

/**
 * ENFORCED since 2026-08-17 (US-2330 AC2, owner's call).
 *
 * It was report-only while the question was open: the static surface had
 * enforced this CSP for a long time but only for STATIC responses, and the
 * Function-served routes are the authenticated app, so an origin the signed-in
 * surface uses and the marketing pages do not would have broken silently at the
 * worst moment. Report-only sent violations to /csp-report without blocking.
 *
 * WHAT SETTLED IT was a measurement rather than a reading of the logs. The
 * enforced policy on `/` and the report-only policy on `/login` and `/dashboard`
 * were fetched from production and are BYTE-IDENTICAL — 1674 bytes, same
 * digest, only the header NAME differing. That matters because a CSP belongs to
 * the DOCUMENT that loaded, and this is a SPA: anyone entering through `/` (a
 * static, enforced response) already navigates the entire signed-in app under
 * this exact policy enforced, and has for a long time. So flipping cannot
 * introduce a new class of breakage. It changes behaviour only for someone who
 * deep-links straight to an authed URL, and gives them the policy everyone else
 * already had.
 *
 * THE ONE THING THAT COMPARISON CANNOT SEE, stated because it is the residual
 * risk and not zero: a subresource fetched from a URL assembled at RUNTIME is
 * invisible to a policy-to-policy diff. The report-only window was the
 * instrument for that, and reading /csp-report remains the way to check it.
 *
 * TO REVERT: flip this to `false`. It needs a deploy, which is the cost the
 * owner accepted; there is no runtime switch.
 */
export const APP_SHELL_CSP_ENFORCED = true;

const encoder = new TextEncoder();

/**
 * The CSP source token for the shell's inline bootstrap, computed from the
 * HTML the Function just fetched.
 *
 * Computing it per response rather than shipping a constant is deliberate: the
 * hash in public/_headers is rewritten at BUILD time by scripts/prerender.mjs
 * from the built script, so a constant here would be a second copy that nothing
 * updates — it would go stale the first time the bootstrap changed, and the
 * symptom would be a blocked Consent Mode / GA bootstrap on signed-in routes
 * only. Extraction mirrors scripts/csp-hash.mjs exactly: the FIRST bare
 * `<script>` (the module loader has attributes and is skipped).
 *
 * Returns null when no inline bootstrap is present, which is a legitimate state
 * for a shell built without one.
 */
export async function inlineBootstrapHash(html: string): Promise<string | null> {
  const m = html.match(/<script>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(m[1]));
  let s = "";
  for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  return `sha256-${btoa(s)}`;
}

/**
 * The full header set for an app-shell response.
 *
 * @param scriptHash the bootstrap's sha256 token, or null. When null the
 *   script-src hash source is dropped rather than left as a placeholder — a
 *   literal `'__HASH__'` source would be a silently dead allowance.
 */
export function appShellSecurityHeaders(
  scriptHash: string | null,
  opts: { enforce?: boolean } = {},
): Record<string, string> {
  const csp = APP_SHELL_CSP_DIRECTIVES.map((d) =>
    scriptHash ? d.replace("__HASH__", scriptHash) : d.replace(" '__HASH__'", "")
  ).join("; ");

  const enforce = opts.enforce ?? APP_SHELL_CSP_ENFORCED;
  return {
    [enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only"]: csp,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    // NOT bare `same-origin` — see the note at the top of this file.
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Reporting-Endpoints": 'csp-endpoint="/csp-report"',
  };
}
