// GradeThread unified extension — the on-marketplace verified badge (US-3060).
//
// A listing that was graded through GradeThread shows its certificate grade
// right on the eBay, Poshmark or Mercari page. Every badge is an ad for the
// certificate and a reason to grade, which is the install loop this feature
// exists to close.
//
// ── WHAT THIS FILE WILL NOT DO ───────────────────────────────────────────────
//
// It NEVER scrapes to find an id. Every id here comes from a URL the browser is
// already on, or from an href the scan pass (US-2237) already collected off the
// grid. On eBay that is the same one-thing-only rule US-3042 wrote down: the
// item id is in the URL, and everything else about an eBay listing comes from
// eBay's API through our server, because their API License Agreement says so.
//
// ── ABSENCE IS NOT A CLAIM ───────────────────────────────────────────────────
//
// A miss renders nothing. A 4xx, a 5xx, a network failure, a malformed body:
// all render nothing. There is no "unverified" badge, ever. Every ungraded
// listing on the page would otherwise become something our extension appears to
// have judged, and most of those sellers have never heard of us.
//
// ── ONE REQUEST PER PAGE LOAD ────────────────────────────────────────────────
//
// Batched, capped, and refused client-side within 60 seconds of the last one on
// the same tab. A grid that re-renders on scroll must not turn into a request
// per scroll; the server's own limiter is the backstop, not the plan.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_LISTING_BADGE = api; // every browser world
})(typeof self !== "undefined" ? self : this, function () {
  /** Mirrors BADGE_PLATFORMS in services/edge-functions/src/lib/listing-certificates.ts. */
  const PLATFORMS = ["ebay", "poshmark", "mercari"];

  /** Mirrors MAX_BADGE_IDS on the edge. The server caps too; this saves a 400. */
  const MAX_IDS = 24;

  /** One batch per page load, and no second one for a minute on the same tab. */
  const REFUSAL_WINDOW_MS = 60 * 1000;

  const ENDPOINT = "/api/grading/public/listing-certificates";

  // ⚠ MIRRORED, NOT INVENTED. These two are byte-identical to `listingIdFromUrl`
  // in closet-import/extract.js, which is itself mirrored from the edge's
  // lib/closet-import.ts. Three copies of one rule is a real cost; the
  // alternative here was worse, because the closet-import bundle is not loaded
  // on a marketplace listing page and reaching for its global would be a
  // dependency that is absent exactly when this runs.
  //
  // test/listing-badge.test.cjs pins these against the closet-import source, so
  // a change there fails this build rather than quietly leaving the badge
  // looking up ids the server keys differently.
  const POSHMARK_ID_RE = /\/listing\/(?:[^/]*-)?([a-f0-9]{24})(?:\/|$)/i;
  const MERCARI_ID_RE = /\/(?:us\/)?item\/(m\d{6,})(?:\/|$)/i;
  const EBAY_ID_RE = /^\d{9,15}$/;

  function isBadgePlatform(p) {
    return typeof p === "string" && PLATFORMS.indexOf(p) !== -1;
  }

  function pathOf(url) {
    try {
      return new URL(url, "https://example.invalid").pathname;
    } catch (_e) {
      return null;
    }
  }

  /**
   * The marketplace's own listing id, off a URL. Null when the URL is not a
   * listing — a grid holds promoted tiles, saved-search links and category
   * links, and none of those is something to ask about.
   *
   * eBay: the id is a path segment or an `item` query parameter, and the rule
   * lives in research/ebay-item-id.js (US-3042). Read through the global when
   * it is loaded, else applied here — the two are the same regex.
   */
  function listingIdFromUrl(platform, url) {
    if (!isBadgePlatform(platform) || typeof url !== "string" || !url) return null;

    if (platform === "ebay") {
      const ebay = typeof self !== "undefined" ? self.GT_EBAY_ITEM : null;
      if (ebay && typeof ebay.itemIdFromUrl === "function") {
        return ebay.itemIdFromUrl(url) || null;
      }
      const path = pathOf(url);
      if (!path) return null;
      const seg = path.split("/").filter(Boolean).pop() || "";
      return EBAY_ID_RE.test(seg) ? seg : null;
    }

    const path = pathOf(url);
    if (!path) return null;
    const re = platform === "poshmark" ? POSHMARK_ID_RE : MERCARI_ID_RE;
    const m = path.match(re);
    return m ? m[1].toLowerCase() : null;
  }

  /**
   * The ids to ask about, from the hrefs the scan pass already collected.
   *
   * De-duplicated and capped. A grid that repeats a promoted listing must not
   * spend two of its 24 slots on it, and the cap is applied AFTER de-duplication
   * so a page showing one item eight times is one id, not a rejected request.
   */
  function badgeIdsFromUrls(platform, urls) {
    const out = [];
    const seen = Object.create(null);
    for (const url of urls || []) {
      const id = listingIdFromUrl(platform, url);
      if (!id || seen[id]) continue;
      seen[id] = true;
      out.push(id);
      if (out.length >= MAX_IDS) break;
    }
    return out;
  }

  /** The GET this makes. Built as a string so a test can assert the whole URL. */
  function badgeRequestUrl(apiBase, platform, ids) {
    const base = String(apiBase || "").replace(/\/+$/, "");
    const q = "platform=" + encodeURIComponent(platform) +
      "&ids=" + encodeURIComponent((ids || []).join(","));
    return base + ENDPOINT + "?" + q;
  }

  /**
   * The per-tab throttle. A closure rather than a module global so a test can
   * drive the clock, and so two tabs cannot share one window.
   *
   * `allow` RECORDS the attempt when it returns true. That is deliberate: a
   * caller that asks and then fails to fetch has still spent its slot, which is
   * the safe direction — a page erroring in a retry loop must not become a
   * request per retry.
   */
  function makeBadgeGate(nowFn) {
    const now = typeof nowFn === "function" ? nowFn : () => Date.now();
    let last = null;
    return {
      allow: function () {
        const t = now();
        if (last !== null && t - last < REFUSAL_WINDOW_MS) return false;
        last = t;
        return true;
      },
      /** Test seam: forget the last attempt, e.g. on a real navigation. */
      reset: function () {
        last = null;
      },
    };
  }

  /**
   * Read the server's answer into a map of listing id -> badge.
   *
   * ANYTHING unexpected produces an EMPTY map, never a partial render and never
   * a thrown error into the overlay: a malformed body is a miss, and a miss
   * shows nothing. Each entry is checked individually, so one bad row in a good
   * response costs that row and not the page.
   */
  function badgesFromResponse(body) {
    const out = Object.create(null);
    if (!body || typeof body !== "object") return out;
    const list = body.certificates;
    if (!Array.isArray(list)) return out;
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const id = typeof row.listingId === "string" ? row.listingId : "";
      const grade = typeof row.grade === "number" ? row.grade : null;
      const tier = typeof row.tier === "string" ? row.tier : "";
      const path = typeof row.path === "string" ? row.path : "";
      // A badge with no grade, no tier or nowhere to go is not a badge.
      if (!id || grade === null || !isFinite(grade) || !tier || !path) continue;
      if (out[id]) continue; // first wins, deterministically
      out[id] = { listingId: id, grade: grade, tier: tier, path: path };
    }
    return out;
  }

  /** The words on the badge. One place, so the detail bar and a card agree. */
  const STRINGS = {
    attribution: "Graded by GradeThread",
    linkTitle: "See the certificate",
  };

  /** "8.5 · Excellent" — the grade first, because that is what is scanned. */
  function badgeLabel(badge) {
    if (!badge) return "";
    return badge.grade.toFixed(1) + " · " + badge.tier;
  }

  /**
   * The certificate URL a badge links to, carrying the attribution the site
   * side reads back (US-3060 AC6/AC7). utm_source is the PLATFORM, which is why
   * the certificate page allowlists it rather than echoing whatever arrives.
   */
  function certificateUrl(siteBase, badge, platform) {
    if (!badge || !badge.path) return null;
    const base = String(siteBase || "").replace(/\/+$/, "");
    const q = "utm_source=" + encodeURIComponent(platform) +
      "&utm_medium=badge";
    return base + badge.path + "?" + q;
  }

  return {
    PLATFORMS,
    MAX_IDS,
    REFUSAL_WINDOW_MS,
    ENDPOINT,
    STRINGS,
    POSHMARK_ID_RE,
    MERCARI_ID_RE,
    isBadgePlatform,
    listingIdFromUrl,
    badgeIdsFromUrls,
    badgeRequestUrl,
    makeBadgeGate,
    badgesFromResponse,
    badgeLabel,
    certificateUrl,
  };
});
