// Defense-in-depth CSP + security headers for the dynamic SSR pages (blog, cert,
// passport, verified, condition-index, authors) served by Pages Functions.
//
// Why this exists: Cloudflare `_headers` (the enforcing CSP in public/_headers)
// applies to STATIC asset responses, NOT to responses returned by Pages
// Functions. These SSR pages render server-injected HTML (e.g. blog body_html),
// so they are exactly the XSS-sensitive surface — yet they previously shipped
// with no CSP at all. body_html is already allowlist-sanitized at write time;
// this is the second line: a nonce-based CSP means even an inline <script> or an
// on*-handler that somehow slipped past sanitization can't execute (it won't
// carry the per-response nonce), while the page's OWN inline scripts (GA config,
// JSON-LD) run because they're stamped with the nonce.
//
// These pages are standalone (they do NOT mount the SPA), so their CSP is much
// tighter than the app shell's — only self + GA + fonts/images, no Stripe /
// PostHog / Sentry / Turnstile.

/** A fresh base64 nonce for one response (16 random bytes). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Full security-header set for an SSR content page, with a nonce-scoped
 * script-src. `nonce` MUST match the nonce stamped on the page's inline scripts
 * (renderLayout(..., { nonce })), or those scripts will be blocked.
 */
export function ssrSecurityHeaders(nonce: string): Record<string, string> {
  const csp = [
    "default-src 'self'",
    // Page's own inline scripts are nonce'd; gtag.js loads from googletagmanager.
    // No 'unsafe-inline' (ignored anyway once a nonce is present) and no
    // 'unsafe-eval' — so injected inline/handler scripts cannot run.
    `script-src 'self' 'nonce-${nonce}' https://www.googletagmanager.com`,
    // The page emits one inline <style> block; allow inline styles (style-based
    // injection is far lower risk and there is no nonce on style-src).
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https://gradethread.com https://*.gradethread.com https://*.googleusercontent.com https://*.ebayimg.com https://*.ebaystatic.com https://www.googletagmanager.com https://*.google-analytics.com https://*.g.doubleclick.net https://pagead2.googlesyndication.com https://www.google.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://*.g.doubleclick.net https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://www.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "report-uri /csp-report",
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
