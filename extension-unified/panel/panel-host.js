// US-3062 AC2: which tabs the panel has anything to say about.
//
// Chromium enables the side panel PER TAB (sidePanel.setOptions({tabId,
// enabled})), so on any other host the action keeps opening popup.html. Firefox
// has no per-tab sidebar option at all: the sidebar is open everywhere, and the
// panel itself renders an "open a marketplace tab" state instead. Two different
// mechanisms, one answer, so the answer lives here rather than being decided
// twice.
//
// Pure and browser-free, because the interesting part is a URL rule and a URL
// rule is only testable when it is not tangled with the tabs API.
//
// IT FAILS OPEN. An unparseable or missing URL is treated as SUPPORTED. A panel
// that wrongly appears costs a seller one glance; a panel that wrongly refuses
// to appear on the listing they are looking at costs them the feature and reads
// as broken. Given the panel's own contents are all "nothing here" states, the
// cheap direction is obvious.

(function (root) {
  "use strict";

  /**
   * Hosts the panel is useful beside: every marketplace the lister or the
   * research overlay already matches. Derived from the selectors config at call
   * time rather than restated, so a marketplace added there is covered here on
   * the same commit.
   */
  function panelHosts(selectors) {
    var out = [];
    if (!selectors || typeof selectors !== "object") return out;
    for (var key in selectors) {
      if (!Object.prototype.hasOwnProperty.call(selectors, key)) continue;
      var cfg = selectors[key];
      var hosts = (cfg && cfg.hosts) || [];
      for (var i = 0; i < hosts.length; i++) {
        if (typeof hosts[i] === "string" && hosts[i]) out.push(hosts[i]);
      }
    }
    return out;
  }

  function hostOf(url) {
    try {
      return new URL(url).host.toLowerCase();
    } catch (_e) {
      return null;
    }
  }

  function hostMatches(host, domain) {
    if (!host || !domain) return false;
    var d = String(domain).toLowerCase();
    return host === d || host.endsWith("." + d);
  }

  /**
   * Should the panel be available beside this URL?
   *
   * Note the two different "true"s: a URL we could not parse is supported
   * because of the fail-open rule above, and a URL on a marketplace host is
   * supported because it is the point of the feature. Only a well-formed URL on
   * a host we match nothing on returns false.
   */
  function isPanelHost(url, selectors) {
    if (typeof url !== "string" || url === "") return true;
    var host = hostOf(url);
    if (!host) return true;
    // Our own site is never a panel host: the seller has the whole app there.
    if (hostMatches(host, "gradethread.com")) return false;
    var hosts = panelHosts(selectors);
    // No selector config at all means we cannot tell, which is the fail-open
    // case again rather than "no marketplaces exist".
    if (hosts.length === 0) return true;
    for (var i = 0; i < hosts.length; i++) {
      if (hostMatches(host, hosts[i])) return true;
    }
    return false;
  }

  /** The platform key for a URL, or null. Used to label the item card. */
  function platformFor(url, selectors) {
    var host = hostOf(url);
    if (!host || !selectors) return null;
    for (var key in selectors) {
      if (!Object.prototype.hasOwnProperty.call(selectors, key)) continue;
      var hosts = (selectors[key] && selectors[key].hosts) || [];
      for (var i = 0; i < hosts.length; i++) {
        if (hostMatches(host, hosts[i])) return key;
      }
    }
    return null;
  }

  root.GT_PANEL_HOST = {
    isPanelHost: isPanelHost,
    platformFor: platformFor,
    panelHosts: panelHosts,
  };
})(typeof self !== "undefined" ? self : globalThis);
