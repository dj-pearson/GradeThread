// GradeThread sold-sync — the content script (US-2698).
//
// PASSIVE HARVEST ONLY. This reads pages the seller opened themselves and sends
// GradeThread nothing else. It never calls tabs.create, never navigates, never
// follows a link, and never runs on a schedule. The background poll is US-2701
// and is a separate, separately-consented feature; test/sync-manifest.test.cjs
// fails the build if navigation appears in this directory.
//
// It also decides nothing. Everything it reads goes through sync/observe.js,
// which can only emit six fields, and then to the server, which owns every
// judgement about what sold. A regression here produces a bad observation, not
// a delisted catalogue.
//
// THE THREE REFUSALS, in the order they are checked:
//   1. Not the right host              → do nothing at all.
//   2. A login wall                    → report not-signed-in, read no rows.
//   3. A human check                   → stop, leave the tab alone.
// Only then does it look at the page. Each of these has a failure mode worse
// than doing nothing: a login page read as a closet is an empty closet, and an
// empty closet is how a selector regression looks exactly like a sell-out.

(function () {
  "use strict";

  const ext = globalThis.browser || globalThis.chrome;
  if (!ext || !ext.runtime) return;

  const SELECTORS = self.GT_SYNC_SELECTORS;
  const OBSERVE = self.GT_SYNC_OBSERVE;
  if (!SELECTORS || !OBSERVE) return;

  const PLATFORM = "poshmark";
  const cfg = SELECTORS[PLATFORM];

  // A flow whose selectors nobody has verified against the live page does not
  // run. This is the same posture as a lister channel reporting "list manually
  // for now" rather than guessing at a form.
  if (!cfg || !cfg.enabled) return;

  function hostAllowed() {
    const host = location.hostname.toLowerCase();
    return (cfg.hosts || []).some(function (h) {
      return host === h || host.endsWith("." + h);
    });
  }

  function isLoginWall() {
    if (cfg.login && cfg.login.urlPattern) {
      try {
        if (new RegExp(cfg.login.urlPattern, "i").test(location.href)) return true;
      } catch (_e) { /* a bad pattern is not a login page */ }
    }
    // The universal tell, and the one that works when an SPA renders login in
    // place without changing the URL.
    return Boolean(document.querySelector('input[type="password"]'));
  }

  function isHumanCheck() {
    if (!cfg.humanCheck) return false;
    try {
      return Boolean(document.querySelector(cfg.humanCheck));
    } catch (_e) {
      return false;
    }
  }

  function matches(pattern) {
    if (!pattern) return false;
    try {
      return new RegExp(pattern, "i").test(location.href);
    } catch (_e) {
      return false;
    }
  }

  /** Text of the first match, or null. Never returns an element or its HTML. */
  function textOf(scope, selector) {
    if (!selector) return null;
    let el;
    try {
      el = scope.querySelector(selector);
    } catch (_e) {
      return null;
    }
    if (!el) return null;
    const t = (el.textContent || "").trim();
    return t || null;
  }

  function hrefOf(scope, selector) {
    if (!selector) return null;
    let el;
    try {
      el = scope.querySelector(selector);
    } catch (_e) {
      return null;
    }
    return el && el.href ? el.href : null;
  }

  /**
   * Read the Sold list.
   *
   * Returns RAW CELLS only — strings, keyed by the five names sync/selectors.js
   * defines. Parsing happens in observe.js, and the six-field allowlist there is
   * what makes it impossible for the buyer's name (printed on this very page) to
   * leave the device, whatever a future selector does.
   */
  function readSold() {
    const flow = cfg.sold;
    const rows = [];
    let nodes = [];
    try {
      nodes = Array.prototype.slice.call(document.querySelectorAll(flow.row));
    } catch (_e) {
      return { rows: rows, ok: false };
    }
    for (const node of nodes) {
      const f = flow.fields || {};
      rows.push({
        listingUrl: hrefOf(node, f.listingUrl),
        title: textOf(node, f.title),
        priceText: textOf(node, f.priceText),
        dateText: textOf(node, f.dateText),
        orderRef: textOf(node, f.orderRef),
      });
    }
    return { rows: rows, ok: true };
  }

  /**
   * Read the active closet, and report honestly how much of it was read.
   *
   * `reachedEnd` is only true when the end marker is on the page. Poshmark's
   * closet is an infinite scroll, and this script does not scroll it — a passive
   * read sees what the seller has already scrolled to. So the ordinary outcome
   * here is PARTIAL coverage, which the server treats as no evidence of absence
   * at all. That is the correct trade: a passive read is worth having for the
   * listings it confirms present, and worth nothing as proof of what is missing.
   */
  function readCloset() {
    const flow = cfg.closet;

    // Whose closet is this? /closet/{handle} matches any seller's.
    let own = false;
    try {
      own = Boolean(document.querySelector(flow.ownClosetTell));
    } catch (_e) {
      own = false;
    }
    if (!own) return null;

    let tiles = [];
    try {
      tiles = Array.prototype.slice.call(document.querySelectorAll(flow.tile));
    } catch (_e) {
      return null;
    }

    const urls = [];
    for (const tile of tiles) {
      // A sold tile is not evidence of a LIVE listing, and counting it as one
      // would suppress the absence signal this read exists for.
      let sold = false;
      try {
        sold = Boolean(flow.soldBadge && tile.querySelector(flow.soldBadge));
      } catch (_e) { /* treat an unreadable badge as not-sold */ }
      if (sold) continue;
      const href = hrefOf(tile, (flow.fields || {}).listingUrl);
      if (href) urls.push(href);
    }

    let reachedEnd = false;
    try {
      const marker = flow.pagination && flow.pagination.endMarker;
      reachedEnd = Boolean(marker && document.querySelector(marker));
    } catch (_e) {
      reachedEnd = false;
    }

    return { urls: urls, pagesRead: 1, reachedEnd: reachedEnd };
  }

  function send(batch) {
    try {
      const p = ext.runtime.sendMessage({ type: "GT_SYNC_OBSERVE", batch: batch });
      if (p && typeof p.catch === "function") p.catch(function () { /* worker asleep */ });
    } catch (_e) { /* never surface an extension error onto the seller's page */ }
  }

  function run() {
    if (!hostAllowed()) return;
    if (isHumanCheck()) return; // stop, hand the tab back, never answer it

    const onSold = matches(cfg.sold && cfg.sold.urlPattern);
    const onCloset = matches(cfg.closet && cfg.closet.urlPattern);
    if (!onSold && !onCloset) return;

    if (isLoginWall()) {
      send(OBSERVE.buildBatch({
        platform: PLATFORM,
        signedIn: false,
        nowIso: new Date().toISOString(),
      }));
      return;
    }

    const nowIso = new Date().toISOString();
    const soldRead = onSold ? readSold() : { rows: [], ok: false };
    const closet = onCloset ? readCloset() : null;

    // Nothing recognised on either page: say nothing rather than report an empty
    // closet. A silent no-op and a confident "you have zero listings" are very
    // different claims, and only one of them can trigger a channel-failing state
    // the seller has to go and understand.
    if (!soldRead.ok && !closet) return;

    send(OBSERVE.buildBatch({
      platform: PLATFORM,
      signedIn: true,
      nowIso: nowIso,
      soldRaw: soldRead.rows,
      closetRaw: closet ? closet.urls : undefined,
      coverage: closet ? { pagesRead: closet.pagesRead, reachedEnd: closet.reachedEnd } : undefined,
    }));
  }

  // One read per page view. Poshmark is an SPA, so a client-side navigation to
  // the Sold page fires no load event; the observer below catches it. There is
  // deliberately no interval and no retry loop: this is a passive harvest, and
  // a script that keeps re-reading a page nobody is looking at is a poll wearing
  // a different name.
  let lastHref = null;
  function maybeRun() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    run();
  }

  maybeRun();
  try {
    new MutationObserver(maybeRun).observe(document.body, { childList: true, subtree: true });
  } catch (_e) { /* no body yet; the initial read already happened */ }
})();
