// GradeThread Lister — background security guard (US-1876)
//
// Pure, side-effect-free validation the background service worker uses to decide
// what it will act on. Kept in its own file (no chrome.* / no listeners) so it is
// unit-testable from the main repo's vitest suite (src/test/lister-guard.test.ts)
// AND loadable in the MV3 service worker via importScripts — the same UMD trick
// exposes it on `self` (worker) or `globalThis` (test).
//
// Why it exists (audit F8/F19/F22): the worker used to open navigation URLs that
// came straight from the external message (payload.newListingUrl / listingUrl),
// so an XSS on ANY *.gradethread.com page could drive the extension to an
// arbitrary URL (and, via the delist flow, to click-through delete controls). The
// guard removes that primitive: list URLs are pinned to the bundled selectors
// config (never the message), and a delist URL must be https AND host-match the
// target platform's known domains before the worker will open it.

(function (root) {
  "use strict";

  /** Lower-cased host of a URL/origin string, or null if unparseable. */
  function hostOf(value) {
    try {
      return new URL(value).host.toLowerCase();
    } catch (_e) {
      return null;
    }
  }

  /** True when `host` equals `domain` or is a subdomain of it. */
  function hostMatches(host, domain) {
    if (!host || !domain) return false;
    const d = String(domain).toLowerCase();
    return host === d || host.endsWith("." + d);
  }

  // AC4: derive the sender host from sender.origin first (the browser-attested
  // origin of the page that sent the message), falling back to sender.url. origin
  // is a bare origin string ("https://app.gradethread.com") which URL() parses.
  function senderHost(sender) {
    const raw = (sender && (sender.origin || sender.url)) || "";
    return hostOf(raw);
  }

  /** Defense-in-depth: only *.gradethread.com may drive the extension. */
  function isOriginAllowed(sender) {
    const host = senderHost(sender);
    return hostMatches(host, "gradethread.com");
  }

  // AC1 (list): the new-listing URL is ALWAYS taken from the bundled selectors
  // config for the requested platform — never from the message. Returns the
  // config https URL, or null when the platform is unknown / misconfigured (the
  // caller then rejects the job rather than opening anything).
  function newListingUrlFor(selectors, platform) {
    const cfg = selectors && selectors[platform];
    const url = cfg && cfg.newListingUrl;
    return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
  }

  // AC1 (delist): a delist targets a live listing whose URL the SaaS supplies, so
  // it can't be pinned to a constant — but it MUST be https and its host must be
  // one of the platform's known domains (selectors[platform].hosts). Anything
  // else (an off-platform or non-https URL smuggled in via a compromised SaaS
  // tab) is rejected before the worker opens a tab.
  function isAllowedDelistUrl(selectors, platform, url) {
    if (typeof url !== "string" || !/^https:\/\//.test(url)) return false;
    const host = hostOf(url);
    if (!host) return false;
    const cfg = selectors && selectors[platform];
    const hosts = (cfg && cfg.hosts) || [];
    return hosts.some(function (h) {
      return hostMatches(host, h);
    });
  }

  // US-2479: the LOCALE-aware form of newListingUrlFor.
  //
  // Vinted runs the same app on ~20 country domains, so "the new-listing URL"
  // is not one string. The seller's account lives on exactly one of them, and
  // sending them to a Vinted they have no account on is worse than doing
  // nothing: they land on a login wall for a country they cannot sign into.
  //
  // The rule that matters is unchanged from AC1 above — the URL we navigate to
  // is ALWAYS a value from the bundled config. What the caller supplies is a
  // locale KEY, which is only ever used to look one up. A payload that names an
  // uncovered locale (or smuggles in a URL) resolves to null, and the caller
  // reports "list manually" naming the domain rather than guessing at a form on
  // a domain nobody has verified.
  //
  // A platform with no `locales` map ignores the key entirely and behaves
  // exactly as before.
  function newListingUrlForLocale(selectors, platform, locale) {
    const cfg = selectors && selectors[platform];
    const locales = cfg && cfg.locales;
    if (!locales) return newListingUrlFor(selectors, platform);
    // No locale asked for → the platform's stated default.
    if (typeof locale !== "string" || locale === "") {
      return newListingUrlFor(selectors, platform);
    }
    // Normalise the two shapes a caller might reasonably send: a bare host
    // ("vinted.fr") or a host with a www prefix. Anything else is not a locale
    // key and must not be coerced into one.
    const key = locale.toLowerCase().replace(/^www\./, "");
    if (!Object.prototype.hasOwnProperty.call(locales, key)) return null;
    const url = locales[key];
    return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
  }

  /** The locale keys a platform covers (empty for a single-domain platform). */
  function localesFor(selectors, platform) {
    const cfg = selectors && selectors[platform];
    const locales = cfg && cfg.locales;
    return locales ? Object.keys(locales) : [];
  }

  // US-1877 (AC1): is this URL a LIVE listing on `platform`?
  //
  // Used to detect that the seller actually submitted the form we prefilled — the
  // marketplace navigates the tab to the new listing. Getting this wrong is not
  // cosmetic: a false positive records a URL as a live cross-listing and flips the
  // row to ACTIVE, which is the phantom-listing bug US-1877 exists to remove.
  //
  // So it is deliberately strict on BOTH axes:
  //   • the HOST must match the platform's known hosts (same rule as delist), so
  //     an outbound link to another site can never be captured; and
  //   • the PATH must match the platform's live-listing shape, anchored, so the
  //     create-listing page we opened cannot match itself.
  function isLiveListingUrl(selectors, platform, url) {
    if (typeof url !== "string" || !/^https:\/\//.test(url)) return false;
    const cfg = selectors && selectors[platform];
    const pattern = cfg && cfg.liveListingUrlPattern;
    if (!pattern) return false;
    const host = hostOf(url);
    if (!host) return false;
    const hosts = (cfg && cfg.hosts) || [];
    if (!hosts.some(function (h) { return hostMatches(host, h); })) return false;
    try {
      return new RegExp(pattern, "i").test(url);
    } catch (_e) {
      // A malformed remote pattern must never capture — failing closed here means
      // the seller falls back to "I published it", not a wrong URL on their row.
      return false;
    }
  }

  root.GT_LISTER_GUARD = {
    hostOf: hostOf,
    hostMatches: hostMatches,
    senderHost: senderHost,
    isOriginAllowed: isOriginAllowed,
    newListingUrlFor: newListingUrlFor,
    newListingUrlForLocale: newListingUrlForLocale,
    localesFor: localesFor,
    isAllowedDelistUrl: isAllowedDelistUrl,
    isLiveListingUrl: isLiveListingUrl,
  };
})(typeof self !== "undefined" ? self : globalThis);
