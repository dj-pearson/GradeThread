// GradeThread unified extension — host-permission access probe (US-1881 AC3).
//
// WHY THIS FILE EXISTS.
//
// Chrome grants everything in `host_permissions` at install time, with no
// prompt. FIREFOX DOES NOT. Under Firefox's MV3 the same block is *opt-in*: the
// add-on installs, the manifest is accepted, the background event page runs —
// and every declared content script stays un-injected until the person opens
// the extensions panel and ticks "Allow". Nothing errors. There is no callback,
// no rejected promise, no console warning. The shopper opens an eBay listing,
// the GradeThread pill never appears, and the only available reading is that
// our software is broken.
//
// That is the exact failure this story was written to prevent, and it is
// invisible from Chrome: every automated guard we have runs the Chrome path,
// where `contains()` answers true forever. So the surface has to ASK, and when
// the answer is no it has to say so in words and offer the grant.
//
// THREE RULES THE PLATFORM FORCES, each of which is a bug if you skip it:
//
//  1. PROBE BEFORE YOU REQUEST. `permissions.request()` on Chrome throws for a
//     permission that is in `host_permissions` rather than
//     `optional_host_permissions` — so a request fired unconditionally breaks
//     the browser it was not needed on. Everything here is built so the request
//     is reachable only from a state that a successful probe ruled out.
//
//  2. REQUEST FROM A USER GESTURE, SYNCHRONOUSLY. `permissions.request()` is
//     refused outside a user input handler, and an `await` before it ends the
//     gesture. Hence the split: `hasHostAccess` (async, at render time) decides
//     whether to show the button; `requestHostAccess` is the FIRST statement of
//     the click handler.
//
//  3. A GRANT DOES NOT REACH OPEN TABS. Firefox injects newly-permitted content
//     scripts on the next navigation only, so the tab the person is looking at
//     stays inert after they say yes — which reads as the grant having failed.
//     `reloadTab` is part of the flow, not a nicety.
//
// FAIL OPEN, ALWAYS. Every probe here answers TRUE when it cannot answer: no
// `permissions` API, a throw, a rejection, a browser that models this
// differently than either of the two we know about. A false negative costs a
// working Chrome user a permission banner for access they already have — a
// scary, wrong prompt on a surface that works. Same rule as the US-1967
// capability probe: a blip must never hide a working feature.
//
// Pure with respect to the browser: every function takes the extension API
// object as its first argument, so the tests drive it with a stub and no
// `chrome`/`browser` global has to exist.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_HOST_PERMS = api; // every browser world
})(typeof self !== "undefined" ? self : this, function () {
  // The bridge origins. Sign-in and every seller-tool call cross this boundary:
  // Firefox has no `externally_connectable`, so gt-bridge.js — an ordinary
  // content script on our own site — IS the transport (US-1882). Un-granted, the
  // popup's "Sign in" opens the connect page and the minted token has nowhere to
  // go, so the flow hangs with no error. These match the manifest's
  // `content_scripts` entry for gradethread.com; keep them in step.
  const SITE_ORIGINS = ["https://gradethread.com/*", "https://*.gradethread.com/*"];

  /**
   * `https://<host>/*` — the narrowest match pattern that covers one site.
   *
   * Deliberately per-HOST and not per-marketplace: the person is looking at one
   * site and is asked about that one site. Requesting `https://*.ebay.com/*`
   * because they happened to open `www.ebay.com` asks for more than the moment
   * justifies, and a broader ask is a likelier refusal.
   *
   * Returns null for anything that is not a plain hostname, so a caller can
   * never build a pattern out of a URL, a port, or an empty string.
   */
  function originPattern(host) {
    if (typeof host !== "string") return null;
    const h = host.trim().toLowerCase();
    if (!h) return null;
    // Hostname only: letters/digits/dots/dashes, at least one dot, no scheme,
    // path, port, credentials or wildcard.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return null;
    return "https://" + h + "/*";
  }

  /**
   * Does this runtime model host permissions as something that can be missing?
   *
   * True on Firefox (and on any Chromium build exposing the API). Used only to
   * decide whether asking is even meaningful — never as a browser sniff.
   */
  function supportsPermissionsApi(api) {
    return Boolean(
      api &&
        api.permissions &&
        typeof api.permissions.contains === "function" &&
        typeof api.permissions.request === "function",
    );
  }

  function containsOrigins(api, origins) {
    if (!origins.length) return Promise.resolve(true);
    if (!supportsPermissionsApi(api)) return Promise.resolve(true); // rule: fail open
    try {
      return Promise.resolve(api.permissions.contains({ origins })).then(
        // A non-boolean answer is not a "no" — it is an answer we do not
        // understand, and rule 3 of this file says that resolves to granted.
        (v) => (typeof v === "boolean" ? v : true),
        () => true,
      );
    } catch (_e) {
      return Promise.resolve(true);
    }
  }

  function requestOrigins(api, origins) {
    if (!origins.length) return Promise.resolve(true);
    if (!supportsPermissionsApi(api)) return Promise.resolve(true);
    try {
      return Promise.resolve(api.permissions.request({ origins })).then(
        (v) => v === true,
        () => false, // a refused/failed request IS a no — this one does not fail open
      );
    } catch (_e) {
      return Promise.resolve(false);
    }
  }

  /** Can the extension run on `host` right now? Fails open (see the header). */
  function hasHostAccess(api, host) {
    const pattern = originPattern(host);
    if (!pattern) return Promise.resolve(true);
    return containsOrigins(api, [pattern]);
  }

  /**
   * Ask for `host`. MUST be the first statement of a user-gesture handler, and
   * must only be reached after `hasHostAccess` said no — see rules 1 and 2.
   * Resolves true only on an explicit grant.
   */
  function requestHostAccess(api, host) {
    const pattern = originPattern(host);
    if (!pattern) return Promise.resolve(false);
    return requestOrigins(api, [pattern]);
  }

  /** Same pair, for the gradethread.com bridge origins. */
  function hasSiteAccess(api) {
    return containsOrigins(api, SITE_ORIGINS);
  }

  function requestSiteAccess(api) {
    return requestOrigins(api, SITE_ORIGINS);
  }

  /**
   * Re-run the content scripts on a tab a grant has just widened. Firefox only
   * injects on the next navigation, so without this the page the person is
   * looking at stays exactly as dead as it was before they said yes.
   */
  function reloadTab(api, tabId) {
    if (typeof tabId !== "number") return Promise.resolve(false);
    try {
      if (!api || !api.tabs || typeof api.tabs.reload !== "function") {
        return Promise.resolve(false);
      }
      return Promise.resolve(api.tabs.reload(tabId)).then(
        () => true,
        () => false,
      );
    } catch (_e) {
      return Promise.resolve(false);
    }
  }

  return {
    SITE_ORIGINS,
    originPattern,
    supportsPermissionsApi,
    hasHostAccess,
    requestHostAccess,
    hasSiteAccess,
    requestSiteAccess,
    reloadTab,
  };
});
