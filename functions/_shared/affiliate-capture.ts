// US-2108 AC2 — carry a ?ref= through the standalone SSR pages.
//
// WHY THIS EXISTS AT ALL, since the story previously recorded the opposite:
//
// The earlier refusal to close AC2 rested on two claims. The first is still
// true and is the reason this file does NOT touch the CTA href: the SSR
// response is SHARED-EDGE-CACHED on origin+pathname with the query string
// dropped (withEdgeCache), so rendering the visitor's ?ref= into any part of the
// HTML would cache the first arriver's code and serve it to everyone after them
// — one seller silently credited for every other visitor's traffic.
//
// The second claim was WRONG. It said "/cert/:id renders under RootLayout, which
// calls captureAffiliateRef() on mount, so a JS-enabled visitor has already
// banked the ref". These pages do not mount the SPA at all — security-headers.ts
// says so in as many words ("These pages are standalone (they do NOT mount the
// SPA)"), and renderLayout emits no #root and no module script. RootLayout only
// runs when the SPA is already loaded and routes to /cert/:id client-side, which
// is not what happens when someone opens a shared certificate link. So the leak
// was not "no-JS crawlers"; it was EVERY visitor arriving through the share
// loop, which is the entire flywheel this story is about.
//
// The fix is the one the story's own note asked for — "a non-query-string
// mechanism (e.g. client-side capture after navigation)". The emitted script is
// BYTE-IDENTICAL for every visitor, so it is safe to cache: it reads the ref
// from the visitor's OWN URL at runtime and banks it in localStorage under the
// same key + shape the SPA's readStored() expects. Nothing about the response
// varies by referral code, so there is no cache to poison.
//
// The click ping is deliberately NOT fired here. It is a cross-origin POST to
// the edge API, and the SSR CSP's connect-src does not include it — widening the
// CSP on the repo's most XSS-sensitive surface to deliver telemetry is a bad
// trade. Instead the ping payload is parked alongside the code and flushed by
// flushPendingAffiliateClick() on the next SPA load (src/lib/affiliate.ts),
// where the connection is already allowed.

/** localStorage key — MUST match STORAGE_KEY in src/lib/affiliate.ts. */
export const AFFILIATE_STORAGE_KEY = "gt_affiliate_ref";

/**
 * A nonce-stamped inline <script> that banks an incoming ?ref= into
 * localStorage. Returns "" when there is no nonce to stamp, because the SSR CSP
 * has no 'unsafe-inline' — an unstamped script would be silently blocked, and
 * emitting dead code that looks like a working feature is the failure mode this
 * story keeps running into.
 *
 * Validation is kept BYTE-FOR-BYTE identical to captureAffiliateRef() (trim,
 * uppercase, reject empty or >32 chars) on purpose. A stricter rule here would
 * mean a code that attributes when the visitor lands on an SPA route and
 * silently does not when they land on an SSR one — attribution that depends on
 * which page the link pointed at is worse than either rule alone.
 */
export function affiliateCaptureSnippet(nonce?: string): string {
  if (!nonce) return "";
  const js =
    `(function(){try{` +
    `var p=new URLSearchParams(window.location.search);` +
    `var c=(p.get("ref")||"").trim().toUpperCase();` +
    `if(!c||c.length>32)return;` +
    `var s=p.get("utm_source");` +
    `var src=(s==="badge"||s==="certificate")?s:"link";` +
    `var r=null;try{if(document.referrer)r=new URL(document.referrer).host||null;}catch(e){}` +
    `localStorage.setItem(${JSON.stringify(AFFILIATE_STORAGE_KEY)},JSON.stringify(` +
    `{code:c,ts:Date.now(),pendingClick:{source:src,path:window.location.pathname,referrer:r}}` +
    `));}catch(e){}})();`;
  return `<script nonce="${nonce}">${js}</script>`;
}
