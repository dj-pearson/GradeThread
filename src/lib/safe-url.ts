// Scheme allowlist for URLs that reach an <a href> / <img src> from the
// database or an external API. React does NOT sanitize `javascript:`/`data:`
// schemes in href (only a dev-mode warning), so a stored or third-party URL
// rendered raw is a stored-XSS vector — sharpest when the value is one tenant's
// data shown to an admin (e.g. the moderation queue).
//
// Prefer this over ad-hoc regexes at call sites. For https-only embed imagery
// see `safeEmbedUrl` in return-to.ts.

const SAFE_SCHEME = /^(https?:|mailto:|tel:)/;
// Control chars (tab/newline/etc.) and spaces that browsers ignore while
// resolving a scheme — `java\tscript:alert(1)` executes, so strip these before
// testing the scheme prefix.
const SCHEME_NOISE = /[\x00-\x20]/g;

/**
 * Returns `raw` if it is a safe link target, else null so the caller can drop
 * the link (e.g. `href={safeHref(url) ?? undefined}` renders inert, non-clickable
 * text rather than an executable `javascript:` link).
 *
 * Allowed: http(s), mailto, tel, and site-relative/fragment/query links.
 * Rejected: javascript:, data:, vbscript:, blob:, and anything unparseable.
 */
export function safeHref(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Site-relative, fragment, and query-only links carry no scheme to abuse.
  if (/^[/#?]/.test(trimmed)) return trimmed;

  const scheme = trimmed.slice(0, 24).replace(SCHEME_NOISE, "").toLowerCase();
  return SAFE_SCHEME.test(scheme) ? trimmed : null;
}
