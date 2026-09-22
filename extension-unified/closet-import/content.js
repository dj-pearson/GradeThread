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

  // ── US-3459: read the WHOLE closet, not the part on screen ─────────────
  //
  // Poshmark and Grailed closets are infinite scroll: the page holds ~48 tiles
  // until the seller scrolls, and the first cut of this reader read exactly
  // those. "Scroll to the bottom first" was in the card's copy and nobody did
  // it, so a 300-listing closet came in as 48. The reader now drives the page
  // to its end itself, on request, before it reads.
  //
  // Still passive in the sense the manifest guard holds: no tab is opened, no
  // navigation happens, nothing polls (setTimeout between rounds, never
  // setInterval) and nothing observes the page on its own. Scrolling a page the
  // seller opened, in answer to a read they asked for, is the reader doing its
  // one job properly. Bounded four ways so a broken page cannot hold the tab.
  const TUNING = (self.GT_CLOSET_IMPORT_TUNING && typeof self.GT_CLOSET_IMPORT_TUNING === "object")
    ? self.GT_CLOSET_IMPORT_TUNING
    : {};
  /** Rounds of scroll-then-wait before giving up on growth. */
  const SCROLL_MAX_ROUNDS = Number(TUNING.maxRounds) > 0 ? Number(TUNING.maxRounds) : 80;
  /** Consecutive rounds that added no tile before the closet counts as settled. */
  const SCROLL_QUIET_ROUNDS = Number(TUNING.quietRounds) > 0 ? Number(TUNING.quietRounds) : 3;
  /** How long a round waits for the page to append tiles. */
  const SCROLL_SETTLE_MS = Number(TUNING.settleMs) > 0 ? Number(TUNING.settleMs) : 700;
  /** Hard wall-clock cap on the whole drive. */
  const SCROLL_TIME_CAP_MS = Number(TUNING.timeCapMs) > 0 ? Number(TUNING.timeCapMs) : 60 * 1000;
  /** Mirrors the server's MAX_CLOSET_IMPORT_ROWS; tiles past it are not sent. */
  const SCROLL_ROW_CAP = Number(TUNING.rowCap) > 0 ? Number(TUNING.rowCap) : 2000;

  function countTiles(flow) {
    try {
      return document.querySelectorAll(flow.tile).length;
    } catch (_e) {
      return 0;
    }
  }

  function endMarkerPresent(flow) {
    try {
      const marker = flow.pagination && flow.pagination.endMarker;
      return Boolean(marker && document.querySelector(marker));
    } catch (_e) {
      return false;
    }
  }

  function scrollToBottom() {
    try {
      const w = typeof window !== "undefined" ? window : null;
      if (!w || typeof w.scrollTo !== "function") return;
      const de = document.documentElement;
      const height = Math.max(
        (de && de.scrollHeight) || 0,
        (document.body && document.body.scrollHeight) || 0,
      );
      w.scrollTo(0, height);
    } catch (_e) { /* a page that refuses to scroll simply settles */ }
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Scroll until the closet stops growing. Returns how the drive ended so the
   * batch can say whether "reachedEnd" means the marker was seen or the page
   * simply stopped producing tiles.
   */
  async function driveToEnd(flow) {
    const startedAt = Date.now();
    let rounds = 0;
    let quiet = 0;
    let last = countTiles(flow);
    while (rounds < SCROLL_MAX_ROUNDS) {
      if (endMarkerPresent(flow)) return { rounds: rounds, stoppedBecause: "end_marker" };
      if (last >= SCROLL_ROW_CAP) return { rounds: rounds, stoppedBecause: "row_cap" };
      if (Date.now() - startedAt > SCROLL_TIME_CAP_MS) return { rounds: rounds, stoppedBecause: "time_cap" };
      scrollToBottom();
      rounds += 1;
      await wait(SCROLL_SETTLE_MS);
      const now = countTiles(flow);
      if (now > last) {
        last = now;
        quiet = 0;
      } else {
        quiet += 1;
        if (quiet >= SCROLL_QUIET_ROUNDS) {
          return { rounds: rounds, stoppedBecause: endMarkerPresent(flow) ? "end_marker" : "settled" };
        }
      }
    }
    return { rounds: rounds, stoppedBecause: endMarkerPresent(flow) ? "end_marker" : "round_cap" };
  }

  /**
   * Read the closet, tile by tile. RAW CELLS only; extract.js parses them.
   *
   * Sold tiles are skipped: a sold listing is not live and would count against
   * the seller's active-listing cap as if it were.
   */
  async function readCloset() {
    const flow = cfg.closet;
    if (!present(flow.ownClosetTell)) return { ok: false, reason: "not_own_closet" };

    const drive = await driveToEnd(flow);

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

    // The end was reached when the marker showed OR the page stopped producing
    // tiles. A cap (rows, rounds, time) is NOT the end, and says so.
    const reachedEnd = drive.stoppedBecause === "end_marker" || drive.stoppedBecause === "settled";
    return {
      ok: true,
      page: "closet",
      rows: rows.slice(0, SCROLL_ROW_CAP),
      coverage: {
        tilesRead: tiles.length,
        reachedEnd: reachedEnd,
        scrollRounds: drive.rounds,
        stoppedBecause: drive.stoppedBecause,
      },
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
  async function read() {
    if (isHumanCheck()) return { ok: false, reason: "human_check" };
    const onCloset = matches(cfg.closet && cfg.closet.urlPattern);
    const onDetail = !onCloset && matches(cfg.detail && cfg.detail.urlPattern);
    if (!onCloset && !onDetail) return { ok: false, reason: "wrong_page" };
    if (isLoginWall()) return { ok: false, reason: "not_signed_in" };

    const got = onCloset ? await readCloset() : readDetail();
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
      // US-3459: the closet read scrolls first, so the answer is asynchronous.
      // Returning true keeps the channel open until sendResponse is called.
      read().then(
        function (out) { sendResponse(out); },
        function () { sendResponse({ ok: false, reason: "nothing_read" }); },
      );
      return true;
    });
  } catch (_e) { /* no runtime messaging in this context */ }
})();
