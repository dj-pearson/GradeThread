// GradeThread closet import — the AUTO-IMPORT DECISIONS (US-3459).
//
// Same split as sync/poll-plan.js, for the same reason: the part of a feature
// that decides whether to act on its own is the part that has to be provable
// without a browser. Everything here is a pure function of what the background
// knows; background.js does the asking, the posting and the notifying.
//
// THE RULES, and what each costs if it goes:
//   1. Never for a signed-out install. No token, no read, no post: the server
//      would refuse the batch anyway, but reading a page for a request that
//      cannot be sent is the wrong shape.
//   2. The seller can switch it off, and off is stored as an explicit false.
//   3. At most once a day per marketplace on its own. The button on the Import
//      page is the re-read-now path and is never throttled here.
//   4. Only the seller's OWN closet page, decided by the same adapter patterns
//      the reader uses, on the same hosts. A stranger's closet URL matches the
//      same pattern, which is why the reader's owner tell still decides the
//      read itself; this file decides only whether to ASK.
(function (root) {
  "use strict";

  /** How long a marketplace is left alone after an automatic import. */
  var MIN_GAP_MS = 24 * 60 * 60 * 1000;

  /** The enabled adapter whose closet page `url` is, or null. */
  function platformForClosetUrl(selectors, url) {
    if (!selectors || typeof url !== "string" || !/^https:\/\//i.test(url)) return null;
    var host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (_e) {
      return null;
    }
    var platforms = Object.keys(selectors);
    for (var i = 0; i < platforms.length; i += 1) {
      var platform = platforms[i];
      var cfg = selectors[platform];
      if (!cfg || !cfg.enabled || !cfg.closet || !cfg.closet.urlPattern) continue;
      var hosts = cfg.hosts || [];
      var onHost = false;
      for (var h = 0; h < hosts.length; h += 1) {
        if (host === hosts[h] || host.endsWith("." + hosts[h])) onHost = true;
      }
      if (!onHost) continue;
      try {
        if (new RegExp(cfg.closet.urlPattern, "i").test(url)) return platform;
      } catch (_e) { /* a bad pattern matches nothing */ }
    }
    return null;
  }

  /**
   * Should the closet on this tab be read now? `state` is what storage holds:
   * gtBuyerToken, closetAutoImport, closetAutoImportLast. Every refusal names
   * its reason so the popup can say it and a test can assert it.
   */
  function decide(state, platform, nowMs) {
    var s = state && typeof state === "object" ? state : {};
    if (!s.gtBuyerToken || typeof s.gtBuyerToken !== "string") {
      return { run: false, reason: "needs_sign_in" };
    }
    if (s.closetAutoImport === false) return { run: false, reason: "off" };
    var lastMap = s.closetAutoImportLast && typeof s.closetAutoImportLast === "object"
      ? s.closetAutoImportLast
      : {};
    var last = Number(lastMap[platform]) || 0;
    if (last && nowMs - last < MIN_GAP_MS) return { run: false, reason: "too_soon" };
    return { run: true, reason: "due" };
  }

  /** The stored map after a successful import of `platform` at `nowMs`. */
  function stamp(lastMap, platform, nowMs) {
    var out = {};
    var m = lastMap && typeof lastMap === "object" ? lastMap : {};
    var keys = Object.keys(m);
    for (var i = 0; i < keys.length; i += 1) out[keys[i]] = m[keys[i]];
    out[platform] = nowMs;
    return out;
  }

  /** The URL a tabs.onUpdated event says the tab is on, or null when it says nothing new. */
  function urlFromTabUpdate(changeInfo, tab) {
    if (changeInfo && typeof changeInfo.url === "string") return changeInfo.url;
    if (changeInfo && changeInfo.status === "complete" && tab && typeof tab.url === "string") return tab.url;
    return null;
  }

  root.GT_CLOSET_IMPORT_AUTO = {
    MIN_GAP_MS: MIN_GAP_MS,
    platformForClosetUrl: platformForClosetUrl,
    decide: decide,
    stamp: stamp,
    urlFromTabUpdate: urlFromTabUpdate,
  };
})(typeof self !== "undefined" ? self : globalThis);
