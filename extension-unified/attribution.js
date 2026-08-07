// GradeThread unified extension — outbound-link attribution (US-1753 AC3).
//
// WHY THIS FILE EXISTS.
//
// The extension is a growth surface: a shopper meets GradeThread on someone
// else's marketplace, and every link back to gradethread.com is the top of the
// signup funnel. The site already closes that loop — main.tsx runs captureUtms()
// on landing, utm-attribution-sync.ts POSTs the stored set to
// /api/attribution/utm once the visitor authenticates, and the admin analytics
// channel table groups by utm_source/medium/campaign. So a tagged link is
// attributed end to end, and an UNTAGGED one is silently counted as "direct".
//
// That is the failure mode this file removes. The tags were hand-written at each
// call site, which meant three different shapes of the same string and at least
// one link ("Watch on GradeThread", the highest-intent click in the overlay)
// carrying none at all — so its signups were invisible to the funnel it belongs
// to. test/attribution.test.cjs now fails the build on any bare gradethread.com
// link in the shipped source, so a new one cannot go untagged again.
//
// PRIVACY — nothing new is collected. utm params are OUR OWN query string on
// OUR OWN site, read by our own page after the user chooses to click. No
// identifier for the person or the install is added (the per-install
// `instanceId` is a grading rate-limit key and deliberately stays out of these
// URLs), so the store data-collection disclosures in SUBMISSION.md are unchanged
// by design — keep it that way.
//
// Loaded as a classic script (`.js`) in every world the extension has: the
// background worker/event page, the extension pages, and the research content
// script. The UMD shim gives node's require() a module.exports for the tests.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_ATTRIBUTION = api; // every browser world
})(typeof self !== "undefined" ? self : this, function (root) {
  const SITE = "https://gradethread.com";
  const SOURCE = "extension";

  // The campaign that marks the INSTALL half of the funnel: a click from the
  // first-run onboarding tab, which the browser opens exactly once per install.
  // Store dashboards report installs; this is what lets a signup be joined back
  // to one, without an install identifier ever leaving the device.
  const INSTALL_CAMPAIGN = "install";

  // gradethread.com and its subdomains only. Anything else is somebody else's
  // site and must never be handed our tags (or rewritten at all).
  const SITE_HOST_RE = /^([a-z0-9-]+\.)*gradethread\.com$/i;

  function runtime() {
    const api = (root && (root.browser || root.chrome)) || null;
    return api && api.runtime ? api.runtime : null;
  }

  /**
   * The shipped extension version, or "" when it can't be read (node tests, a
   * page with no runtime). Rides along as utm_content so a signup can be traced
   * to the build that produced it — which is the only way to tell a store
   * release's cohort apart from the installs that preceded it.
   */
  function version() {
    try {
      const rt = runtime();
      const m = rt && rt.getManifest ? rt.getManifest() : null;
      return m && m.version ? String(m.version) : "";
    } catch (_e) {
      return "";
    }
  }

  /** True for an absolute https URL on gradethread.com (or a subdomain). */
  function isSiteUrl(url) {
    try {
      const u = new URL(String(url));
      return u.protocol === "https:" && SITE_HOST_RE.test(u.hostname);
    } catch (_e) {
      return false;
    }
  }

  function setIfAbsent(u, key, value) {
    if (!value) return;
    if (u.searchParams.get(key)) return;
    u.searchParams.set(key, value);
  }

  /**
   * Add the funnel tags to an ALREADY-ABSOLUTE gradethread.com URL.
   *
   * Two rules, both deliberate:
   *  • A non-site URL is returned untouched. The overlay renders marketplace
   *    links through the same helpers; tagging one would rewrite a third party's
   *    URL, and silently returning "" would break the link.
   *  • An existing utm value WINS. The public grading endpoint builds its own
   *    deep links (public-grading.ts: /tools/grade-checker, /signup, the fit
   *    surface) with the medium that describes the SERVER's intent. Decorating
   *    those fills in only what is missing — the version cohort — instead of
   *    overwriting a medium the server chose.
   *
   * @param {string} url      absolute URL
   * @param {string} medium   utm_medium — the surface the click came from
   * @param {{campaign?: string, params?: Object}} [opts]
   */
  function decorate(url, medium, opts) {
    const raw = typeof url === "string" ? url : "";
    if (!isSiteUrl(raw)) return raw;
    const o = opts || {};
    const u = new URL(raw);

    // Functional params first and unconditionally — they are the request, not
    // the attribution (?watch=<listing>, ?ext=<extension id>).
    if (o.params) {
      for (const k of Object.keys(o.params)) {
        const v = o.params[k];
        if (v === undefined || v === null || v === "") continue;
        u.searchParams.set(k, String(v));
      }
    }

    setIfAbsent(u, "utm_source", SOURCE);
    setIfAbsent(u, "utm_medium", medium || SOURCE);
    if (o.campaign) setIfAbsent(u, "utm_campaign", o.campaign);
    const v = version();
    if (v) setIfAbsent(u, "utm_content", "v" + v);
    return u.toString();
  }

  /**
   * Build a tagged gradethread.com URL from a path ("/pricing", "pricing" or an
   * absolute gradethread.com URL — all three are accepted so a call site never
   * has to think about it).
   */
  function siteUrl(path, medium, opts) {
    let p = typeof path === "string" && path ? path : "/";
    if (/^https?:/i.test(p)) return decorate(p, medium, opts);
    if (p.charAt(0) !== "/") p = "/" + p;
    return decorate(SITE + p, medium, opts);
  }

  return {
    SITE,
    SOURCE,
    INSTALL_CAMPAIGN,
    version,
    isSiteUrl,
    decorate,
    siteUrl,
  };
});
