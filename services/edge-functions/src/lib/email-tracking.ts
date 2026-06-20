// US-938: open/click tracking rewriter (US-913) + pre-send QA gate (US-924).
//
// Pure + dependency-free (string in → string out, no supabase/env) so the drip
// engine, the broadcast sender, and their tests all use it without an env dance.
//
// The rewriter rewrites every http(s) anchor to pass through the click-tracking
// redirect and injects a 1x1 open pixel; the public endpoints in
// routes/drip-tracking.ts stamp drip_sends.opened_at / clicked_at when an email
// client loads the pixel or follows a wrapped link. The QA gate is the last
// guard before a send: it refuses a rendered email that is obviously broken
// (empty subject/body, an un-substituted {{token}} that leaked past rendering).

// Path the tracking endpoints are mounted at (a sibling of /api/drip so it is
// NOT behind the drip job-auth middleware — email clients are unauthenticated).
export const DRIP_TRACK_BASE_PATH = "/api/drip-track";

// 1x1 transparent GIF — what the open-pixel endpoint returns.
export const TRACKING_PIXEL_BASE64 =
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Decode the tracking pixel to raw bytes for the image response. */
export function trackingPixelBytes(): Uint8Array {
  const bin = atob(TRACKING_PIXEL_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function openPixelUrl(baseUrl: string, token: string): string {
  return `${baseUrl}${DRIP_TRACK_BASE_PATH}/o/${encodeURIComponent(token)}`;
}

function clickWrapUrl(baseUrl: string, token: string, target: string): string {
  return `${baseUrl}${DRIP_TRACK_BASE_PATH}/c/${encodeURIComponent(token)}?u=${
    encodeURIComponent(target)
  }`;
}

// Links that must reach their real endpoint directly (never wrapped): the
// tracking endpoints themselves and the CAN-SPAM unsubscribe link — a one-click
// unsubscribe has to work even if the tracking redirect is down.
function isPassthroughLink(url: string): boolean {
  return url.includes(DRIP_TRACK_BASE_PATH) ||
    /\/unsubscribe|\/api\/notifications\/unsubscribe/i.test(url);
}

/**
 * Rewrite every http(s) `href` to pass through the click-tracking redirect,
 * EXCEPT pass-through links (unsubscribe / tracking). Leaves mailto:, tel:,
 * anchors, and `src` attributes untouched.
 */
export function rewriteLinksForClickTracking(
  html: string,
  baseUrl: string,
  token: string,
): string {
  return html.replace(
    /href="(https?:\/\/[^"]+)"/gi,
    (whole, url: string) =>
      isPassthroughLink(url) ? whole : `href="${clickWrapUrl(baseUrl, token, url)}"`,
  );
}

/** Inject the hidden open-tracking pixel just before </body> (or append it). */
export function injectOpenPixel(
  html: string,
  baseUrl: string,
  token: string,
): string {
  const pixel =
    `<img src="${openPixelUrl(baseUrl, token)}" width="1" height="1" alt="" ` +
    `style="display:none;width:1px;height:1px" />`;
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${pixel}</body>`)
    : html + pixel;
}

/** Apply both transforms: rewrite links, then inject the open pixel. */
export function applyEmailTracking(
  html: string,
  baseUrl: string,
  token: string,
): string {
  return injectOpenPixel(
    rewriteLinksForClickTracking(html, baseUrl, token),
    baseUrl,
    token,
  );
}

export interface EmailQaResult {
  ok: boolean;
  issues: string[];
}

/**
 * US-924 QA gate: the last check before a send. Fails a rendered email that is
 * obviously broken so a bad merge never goes out — an empty subject or body, or
 * an un-substituted `{{token}}` that leaked past rendering. Pure, so the engine
 * runs it on every step and the test asserts it without a DB.
 */
export function qaCheckEmail(input: { subject: string; html: string }): EmailQaResult {
  const issues: string[] = [];
  const subject = (input.subject ?? "").trim();
  const html = input.html ?? "";
  const TOKEN_RE = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/;

  if (!subject) issues.push("empty_subject");
  if (!html.replace(/<[^>]*>/g, "").trim()) issues.push("empty_body");
  if (TOKEN_RE.test(subject) || TOKEN_RE.test(html)) issues.push("unrendered_token");

  return { ok: issues.length === 0, issues };
}
