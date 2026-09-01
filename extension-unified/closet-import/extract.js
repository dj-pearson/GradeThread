// GradeThread closet import — the pure half of reading a seller's own listings (US-9201).
//
// NO chrome.*, NO DOM, NO fetch, for the same reason sync/observe.js has none:
// the content script hands this module strings it scraped, and this module
// turns them into exactly the listing shape the server accepts and REFUSES to
// carry anything else. A closet tile prints nothing sensitive, but the same
// script runs on the seller's own listing page, which sits one click from their
// order history; an adapter that grabbed "the whole card" would be the first
// half of somebody posting a buyer's name. So the emitted shape is an allowlist:
// buildListing constructs a fresh object with ALLOWED_LISTING_FIELDS and never
// spreads its input. test/closet-import-extract.test.cjs holds that.
//
// It also decides nothing about what an import DOES. The server dedupes on the
// marketplace id, fills blanks, copies photos and records the effect rows; a
// regression here produces a wrong row that is one Undo away.

(function (root) {
  "use strict";

  /** Every key a listing may carry. Adding one here is the deliberate act. */
  const ALLOWED_LISTING_FIELDS = [
    "listingUrl",
    "platformListingId",
    "title",
    "description",
    "priceCents",
    "size",
    "brand",
    "condition",
    "photoUrls",
    "detail",
  ];

  /** Photos per listing. Mirrors MAX_CLOSET_IMPORT_PHOTOS on the server. */
  const MAX_PHOTOS = 8;

  function clean(v) {
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }

  /** Canonical listing URL: scheme + host + path, no query, no trailing slash. */
  function canonicalUrl(raw) {
    const s = clean(raw);
    if (!s) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      const path = u.pathname.replace(/\/+$/, "");
      return u.protocol + "//" + u.host.toLowerCase() + path;
    } catch (_e) {
      return null;
    }
  }

  /**
   * The marketplace's own id, read off the listing URL. MIRRORS
   * listingIdFromUrl in the edge's lib/closet-import.ts: the server re-derives
   * it and drops a row it cannot key, so this exists only so the content script
   * can skip a tile that is not a listing before it reads anything else.
   */
  function listingIdFromUrl(platform, url) {
    const c = canonicalUrl(url);
    if (!c) return null;
    let path;
    try {
      path = new URL(c).pathname;
    } catch (_e) {
      return null;
    }
    if (platform === "poshmark") {
      const m = path.match(/\/listing\/(?:[^/]*-)?([a-f0-9]{24})(?:\/|$)/i);
      return m ? m[1].toLowerCase() : null;
    }
    if (platform === "mercari") {
      const m = path.match(/\/(?:us\/)?item\/(m\d{6,})(?:\/|$)/i);
      return m ? m[1].toLowerCase() : null;
    }
    return null;
  }

  /** "$85", "$1,234.56", "US$85.00" -> cents. Unrecognisable -> null, never 0. */
  function parsePriceCents(text) {
    const s = clean(text);
    if (!s) return null;
    const m = s.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }

  /**
   * The adapter's URL-upgrade rule, applied. Same contract as
   * research/image-utils.js applyUrlUpgrade: a malformed pattern returns the
   * URL unchanged rather than throwing into the read loop.
   */
  function applyUrlUpgrade(url, upgrade) {
    if (typeof url !== "string" || !url) return url;
    if (!upgrade || typeof upgrade.pattern !== "string" || typeof upgrade.replacement !== "string") {
      return url;
    }
    let re;
    try {
      re = new RegExp(upgrade.pattern, typeof upgrade.flags === "string" ? upgrade.flags : "");
    } catch (_e) {
      return url;
    }
    try {
      return url.replace(re, upgrade.replacement);
    } catch (_e) {
      return url;
    }
  }

  /** Largest candidate of a srcset, or null. */
  function srcsetLargest(srcset) {
    if (typeof srcset !== "string" || !srcset.trim()) return null;
    let best = null;
    let bestW = -1;
    for (const part of srcset.split(",")) {
      const bits = part.trim().split(/\s+/);
      const url = bits[0];
      if (!url) continue;
      const w = bits[1] && /^\d+w$/.test(bits[1]) ? Number(bits[1].slice(0, -1)) : 0;
      if (w > bestW) {
        bestW = w;
        best = url;
      }
    }
    return best;
  }

  /** First absolute https URL among raw attribute candidates. */
  function pickImageUrl(candidates) {
    for (const raw of candidates || []) {
      if (typeof raw !== "string") continue;
      const v = raw.trim();
      if (/^https:\/\//i.test(v)) return v;
    }
    return null;
  }

  /** Dedupe by CDN asset id when the adapter names one, else by URL. Cap. */
  function dedupeUrls(urls, limit, assetIdPattern) {
    let re = null;
    if (typeof assetIdPattern === "string" && assetIdPattern) {
      try {
        re = new RegExp(assetIdPattern, "i");
      } catch (_e) {
        re = null;
      }
    }
    const out = [];
    const seen = Object.create(null);
    for (const u of urls || []) {
      if (typeof u !== "string" || !u) continue;
      let identity = u;
      if (re) {
        try {
          const m = re.exec(u);
          if (m && m[1]) identity = "asset:" + m[1];
        } catch (_e) { /* keep URL identity */ }
      }
      if (seen[identity]) continue;
      seen[identity] = true;
      out.push(u);
      if (typeof limit === "number" && out.length >= limit) break;
    }
    return out;
  }

  /**
   * Upgrade + dedupe + cap a list of raw photo URLs through the adapter.
   *
   * The upgrade runs BEFORE dedupe so the small and large renders of one shot
   * collapse to the large one, and never the other way round.
   */
  function preparePhotoUrls(rawUrls, adapter) {
    const a = adapter && typeof adapter === "object" ? adapter : {};
    const upgraded = [];
    for (const u of Array.isArray(rawUrls) ? rawUrls : []) {
      const picked = pickImageUrl([u]);
      if (picked) upgraded.push(applyUrlUpgrade(picked, a.urlUpgrade));
    }
    return dedupeUrls(upgraded, MAX_PHOTOS, a.assetIdPattern);
  }

  /**
   * Build one listing. A FRESH object with exactly ALLOWED_LISTING_FIELDS;
   * `raw` is read key by key and never spread. Returns null when the row has
   * no marketplace id, because the server would drop it anyway and a row that
   * cannot be keyed cannot be deduped on a re-run.
   */
  function buildListing(platform, raw, adapter) {
    const r = raw && typeof raw === "object" ? raw : {};
    const listingUrl = canonicalUrl(r.listingUrl);
    const id = listingIdFromUrl(platform, listingUrl);
    if (!listingUrl || !id) return null;
    const title = clean(r.title);
    if (!title) return null;
    const description = clean(r.description);
    const size = clean(r.sizeText);
    const brand = clean(r.brandText);
    const condition = clean(r.conditionText);
    return {
      listingUrl: listingUrl,
      platformListingId: id,
      title: title.slice(0, 200),
      description: description ? description.slice(0, 8000) : null,
      priceCents: typeof r.priceCents === "number" ? Math.round(r.priceCents) : parsePriceCents(r.priceText),
      size: size ? size.slice(0, 40) : null,
      brand: brand ? brand.slice(0, 80) : null,
      condition: condition ? condition.slice(0, 80) : null,
      photoUrls: preparePhotoUrls(r.photoUrls, adapter),
      detail: r.detail === true,
    };
  }

  /**
   * Build the batch the background posts. `page` is "closet" or "detail";
   * `coverage` says how much of the closet the read saw, and is coerced so a
   * malformed value under-claims rather than invents completeness.
   */
  function buildBatch(input) {
    const i = input && typeof input === "object" ? input : {};
    const platform = clean(i.platform);
    const adapter = i.adapter && typeof i.adapter === "object" ? i.adapter : {};
    const listings = [];
    const seen = Object.create(null);
    for (const raw of Array.isArray(i.rawListings) ? i.rawListings : []) {
      const built = buildListing(platform, raw, adapter);
      if (!built) continue;
      if (seen[built.platformListingId]) continue;
      seen[built.platformListingId] = true;
      listings.push(built);
    }
    const cov = i.coverage && typeof i.coverage === "object" ? i.coverage : {};
    return {
      platform: platform,
      page: i.page === "detail" ? "detail" : "closet",
      listings: listings,
      coverage: {
        tilesRead: typeof cov.tilesRead === "number" && cov.tilesRead >= 0 ? Math.floor(cov.tilesRead) : listings.length,
        reachedEnd: cov.reachedEnd === true,
      },
    };
  }

  root.GT_CLOSET_IMPORT_EXTRACT = {
    ALLOWED_LISTING_FIELDS: ALLOWED_LISTING_FIELDS,
    MAX_PHOTOS: MAX_PHOTOS,
    canonicalUrl: canonicalUrl,
    listingIdFromUrl: listingIdFromUrl,
    parsePriceCents: parsePriceCents,
    applyUrlUpgrade: applyUrlUpgrade,
    srcsetLargest: srcsetLargest,
    pickImageUrl: pickImageUrl,
    dedupeUrls: dedupeUrls,
    preparePhotoUrls: preparePhotoUrls,
    buildListing: buildListing,
    buildBatch: buildBatch,
  };
})(typeof self !== "undefined" ? self : globalThis);
