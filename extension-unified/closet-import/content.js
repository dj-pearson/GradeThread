// GradeThread closet import — the content script (US-9201).
//
// READS ON REQUEST ONLY. Unlike sold-sync, which harvests passively every time
// the seller lands on their Sold page, this script does nothing until the
// background asks it to (GT_CLOSET_IMPORT_READ), and the background asks only
// because the seller pressed "Import my closet". It never calls tabs.create,
// never navigates, never follows a link and never runs on a timer;
// test/closet-import-manifest.test.cjs fails the build if any of that appears
// in this directory. Everything it reads goes through closet-import/extract.js,
// which can emit exactly ten fields per listing, and then to the server, which
// owns every judgement about what to create, fill or skip.
//
// THE THREE REFUSALS, in the order they are checked, same as sync/content.js:
//   1. Not the right host              -> do nothing at all.
//   2. A human check                   -> stop, leave the tab alone, say so.
//   3. A login wall                    -> report not-signed-in, read no rows.
// Plus one of its own: a closet URL matches ANY seller's closet, so a page that
// does not show the owner-only controls is refused before a tile is read. An
// import of somebody else's closet would put their listings in the seller's
// catalogue as if they were the seller's own.

(function () {
  "use strict";

  const ext = globalThis.browser || globalThis.chrome;
  if (!ext || !ext.runtime) return;

  const SELECTORS = self.GT_CLOSET_IMPORT_SELECTORS;
  const EXTRACT = self.GT_CLOSET_IMPORT_EXTRACT;
  if (!SELECTORS || !EXTRACT) return;

  function resolvePlatform() {
    const host = location.hostname.toLowerCase();
    for (const key of Object.keys(SELECTORS)) {
      const hosts = SELECTORS[key].hosts || [];
      for (const h of hosts) {
        if (host === h || host.endsWith("." + h)) return key;
      }
    }
    return null;
  }

  const PLATFORM = resolvePlatform();
  if (!PLATFORM) return;
  const cfg = SELECTORS[PLATFORM];
  if (!cfg || !cfg.enabled) return;

  function isLoginWall() {
    if (cfg.login && cfg.login.urlPattern) {
      try {
        if (new RegExp(cfg.login.urlPattern, "i").test(location.href)) return true;
      } catch (_e) { /* a bad pattern is not a login page */ }
    }
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

  function present(selector) {
    if (!selector) return false;
    try {
      return Boolean(document.querySelector(selector));
    } catch (_e) {
      return false;
    }
  }

  /** Text of the first match, or null. Never an element, never its HTML. */
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

  /** Raw src candidates of every img under `selector` inside `scope`. */
  function imageUrlsOf(scope, selector) {
    if (!selector) return [];
    let nodes = [];
    try {
      nodes = Array.prototype.slice.call(scope.querySelectorAll(selector));
    } catch (_e) {
      return [];
    }
    const attrs = cfg.imageAttrs || ["src"];
    const out = [];
    for (const el of nodes) {
      const candidates = [];
      for (const attr of attrs) {
        let raw = null;
        try {
          raw = el.getAttribute ? el.getAttribute(attr) : null;
        } catch (_e) {
          raw = null;
        }
        if (!raw) continue;
        candidates.push(attr === "srcset" ? EXTRACT.srcsetLargest(raw) : raw);
      }
      const picked = EXTRACT.pickImageUrl(candidates);
      if (picked) out.push(picked);
    }
    return out;
  }

  /**
   * Read the closet, tile by tile. RAW CELLS only; extract.js parses them.
   *
   * Sold tiles are skipped: a sold listing is not live and would count against
   * the seller's active-listing cap as if it were.
   */
  function readCloset() {
    const flow = cfg.closet;
    if (!present(flow.ownClosetTell)) return { ok: false, reason: "not_own_closet" };

    let tiles = [];
    try {
      tiles = Array.prototype.slice.call(document.querySelectorAll(flow.tile));
    } catch (_e) {
      return { ok: false, reason: "nothing_read" };
    }
    const f = flow.fields || {};
    const rows = [];
    let sold = 0;
    for (const tile of tiles) {
      let isSold = false;
      try {
        isSold = Boolean(flow.soldBadge && tile.querySelector(flow.soldBadge));
      } catch (_e) { /* treat an unreadable badge as not-sold */ }
      if (isSold) {
        sold++;
        continue;
      }
      rows.push({
        listingUrl: hrefOf(tile, f.listingUrl),
        title: textOf(tile, f.title),
        priceText: textOf(tile, f.priceText),
        sizeText: textOf(tile, f.sizeText),
        brandText: textOf(tile, f.brandText),
        photoUrls: imageUrlsOf(tile, f.image).slice(0, 1),
      });
    }
    if (rows.length === 0 && sold === 0) return { ok: false, reason: "nothing_read" };

    let reachedEnd = false;
    try {
      const marker = flow.pagination && flow.pagination.endMarker;
      reachedEnd = Boolean(marker && document.querySelector(marker));
    } catch (_e) {
      reachedEnd = false;
    }
    return {
      ok: true,
      page: "closet",
      rows: rows,
      coverage: { tilesRead: tiles.length, reachedEnd: reachedEnd },
    };
  }

  /** Read one of the seller's OWN listing pages in full. */
  function readDetail() {
    const flow = cfg.detail;
    if (!present(flow.ownListingTell)) return { ok: false, reason: "not_own_listing" };
    const row = {
      listingUrl: location.href,
      title: textOf(document, flow.title),
      description: textOf(document, flow.description),
      priceText: textOf(document, flow.priceText),
      sizeText: textOf(document, flow.sizeText),
      brandText: textOf(document, flow.brandText),
      conditionText: textOf(document, flow.conditionText),
      photoUrls: imageUrlsOf(document, flow.gallery),
      detail: true,
    };
    if (!row.title) return { ok: false, reason: "nothing_read" };
    return { ok: true, page: "detail", rows: [row], coverage: { tilesRead: 1, reachedEnd: true } };
  }

  /** The read, as the background asked for it. Decides nothing; reports honestly. */
  function read() {
    if (isHumanCheck()) return { ok: false, reason: "human_check" };
    const onCloset = matches(cfg.closet && cfg.closet.urlPattern);
    const onDetail = !onCloset && matches(cfg.detail && cfg.detail.urlPattern);
    if (!onCloset && !onDetail) return { ok: false, reason: "wrong_page" };
    if (isLoginWall()) return { ok: false, reason: "not_signed_in" };

    const got = onCloset ? readCloset() : readDetail();
    if (!got.ok) return got;
    const batch = EXTRACT.buildBatch({
      platform: PLATFORM,
      page: got.page,
      rawListings: got.rows,
      coverage: got.coverage,
      adapter: cfg,
    });
    if (batch.listings.length === 0) return { ok: false, reason: "nothing_read" };
    return { ok: true, batch: batch };
  }

  try {
    ext.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      if (!msg || msg.type !== "GT_CLOSET_IMPORT_READ") return undefined;
      try {
        sendResponse(read());
      } catch (_e) {
        sendResponse({ ok: false, reason: "nothing_read" });
      }
      return undefined;
    });
  } catch (_e) { /* no runtime messaging in this context */ }
})();
