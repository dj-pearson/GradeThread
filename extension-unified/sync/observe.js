// GradeThread sold-sync — the pure half of reading a seller's own pages (US-2698).
//
// WHAT THIS FILE IS DEFENDING, AND WHY IT HAS NO chrome.*, NO DOM AND NO fetch.
//
// The content script's job is to hand this module strings it scraped. This
// module's job is to turn them into the exact observation the server accepts,
// and — the part that matters — to REFUSE to carry anything else. A Poshmark
// order row prints the buyer's name and their shipping address right next to
// the sale price. An adapter that grabbed "the whole row" would post both to
// GradeThread, and nobody would have decided to do that.
//
// So the emitted shape is an allowlist, not a filter: buildSoldObservation
// constructs a fresh object with exactly ALLOWED_SOLD_FIELDS on it and never
// spreads its input. An unknown key cannot survive, whatever the caller does.
// test/sync-observe.test.cjs holds that, and a build fails if it is loosened.
//
// It also decides NOTHING about what sold. That is the server's job
// (lib/marketplace-observations.ts), because a selector regression must produce
// a bad observation rather than a bad delist.

(function (root) {
  "use strict";

  /**
   * The complete set of keys a sold observation may carry.
   *
   * This is the privacy contract expressed as data. Adding a key here is the
   * deliberate act; nothing else can add one by accident.
   */
  const ALLOWED_SOLD_FIELDS = [
    "listingUrl",
    "title",
    "soldPriceCents",
    "soldAt",
    "orderRef",
    "thumbAssetId",
  ];

  const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  function clean(v) {
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }

  /**
   * Canonical listing URL. Mirrors canonicalUrl() in the server planner, and
   * has to: the server matches a sold row to a listing by string equality, so
   * two spellings of one URL are two listings.
   */
  function canonicalUrl(raw) {
    const s = clean(raw);
    if (!s) return null;
    try {
      const u = new URL(s);
      const path = u.pathname.replace(/\/+$/, "");
      return (u.protocol + "//" + u.host.toLowerCase() + path).toLowerCase();
    } catch (_e) {
      return s.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
    }
  }

  /**
   * "$85", "$1,234.56", "US$85.00" → cents. Anything unrecognisable → null.
   *
   * Null rather than zero, deliberately. A zero price reads as a real sale at
   * no money and would land in the seller's P&L as one; a null says we could
   * not read it, which is true.
   */
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
   * A sold date, as an ISO instant, or null.
   *
   * `nowIso` is a PARAMETER rather than a Date.now() call so this stays pure and
   * so "3 days ago" is testable at all.
   *
   * Null is a first-class answer. The server's dedupe key falls back to the
   * listing URL plus the (possibly empty) date, so an unparsed date still
   * dedupes consistently across reads — it just cannot distinguish two sales of
   * the same URL, which is not a case that exists.
   */
  function parseSoldAt(text, nowIso) {
    const s = clean(text);
    if (!s) return null;
    const now = new Date(nowIso);
    if (!Number.isFinite(now.getTime())) return null;

    // Already an instant.
    const iso = Date.parse(s);
    if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(iso)) {
      return new Date(iso).toISOString();
    }

    const lower = s.toLowerCase();

    if (/\btoday\b/.test(lower)) return dayOf(now, 0);
    if (/\byesterday\b/.test(lower)) return dayOf(now, -1);

    const rel = lower.match(/(\d+)\s*(day|week|month)s?\s*ago/);
    if (rel) {
      const n = Number(rel[1]);
      const unit = rel[2];
      if (unit === "day") return dayOf(now, -n);
      if (unit === "week") return dayOf(now, -n * 7);
      if (unit === "month") return dayOf(now, -n * 30);
    }

    // "Aug 18, 2026" / "Aug 18" / "18 Aug 2026"
    // The (?!\d) on each day group is load-bearing. Without it "18 Aug 2026"
    // matches the MONTH-FIRST pattern as month=aug, day=20 — eating the first
    // two digits of the year — and silently stamps the sale two days late.
    const named = lower.match(/([a-z]{3,})\.?\s+(\d{1,2})(?!\d)(?:,?\s*(\d{4})(?!\d))?/) ||
      lower.match(/(\d{1,2})(?!\d)\s+([a-z]{3,})\.?(?:,?\s*(\d{4})(?!\d))?/);
    if (named) {
      let monthWord, dayNum;
      if (/^\d/.test(named[1])) {
        dayNum = Number(named[1]);
        monthWord = named[2];
      } else {
        monthWord = named[1];
        dayNum = Number(named[2]);
      }
      const month = MONTHS[String(monthWord).slice(0, 3)];
      if (month === undefined || !Number.isFinite(dayNum)) return null;
      let year = named[3] ? Number(named[3]) : now.getUTCFullYear();
      const built = new Date(Date.UTC(year, month, dayNum));
      // A bare "Aug 18" that lands in the future means last year. Poshmark drops
      // the year on recent sales, so every December read of a January sale would
      // otherwise be stamped eleven months early.
      if (!named[3] && built.getTime() > now.getTime()) {
        return new Date(Date.UTC(year - 1, month, dayNum)).toISOString();
      }
      return built.toISOString();
    }

    return null;
  }

  function dayOf(now, offsetDays) {
    const d = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + offsetDays,
    ));
    return d.toISOString();
  }

  /**
   * Build one sold observation.
   *
   * Constructs a FRESH object with exactly ALLOWED_SOLD_FIELDS. `raw` is read
   * key by key and never spread, so a caller handing over a whole scraped row
   * complete with `buyerName` and `shippingAddress` contributes nothing but the
   * six fields below.
   */
  function buildSoldObservation(raw, nowIso) {
    const r = raw && typeof raw === "object" ? raw : {};
    return {
      listingUrl: canonicalUrl(r.listingUrl),
      title: clean(r.title),
      soldPriceCents: typeof r.soldPriceCents === "number"
        ? Math.round(r.soldPriceCents)
        : parsePriceCents(r.priceText),
      soldAt: clean(r.soldAt) && /^\d{4}-\d{2}-\d{2}/.test(String(r.soldAt))
        ? new Date(String(r.soldAt)).toISOString()
        : parseSoldAt(r.dateText, nowIso),
      orderRef: clean(r.orderRef),
      thumbAssetId: clean(r.thumbAssetId),
    };
  }

  /**
   * Build the closet half.
   *
   * `reachedEnd` is the single most consequential field in this file. The server
   * only treats a listing's absence as evidence when the enumeration was
   * complete, so a page-1-of-8 read that claimed completion would report a mass
   * delisting. It is therefore coerced to a strict boolean: anything that is not
   * literally `true` reads as false, and the read under-claims rather than
   * invents.
   */
  function buildClosetObservation(rawUrls, coverage) {
    const cov = coverage && typeof coverage === "object" ? coverage : {};
    const urls = [];
    const seen = Object.create(null);
    if (Array.isArray(rawUrls)) {
      for (const u of rawUrls) {
        const c = canonicalUrl(u);
        if (c && !seen[c]) {
          seen[c] = true;
          urls.push(c);
        }
      }
    }
    return {
      listingUrls: urls,
      pagesRead: Number.isFinite(cov.pagesRead) ? Math.max(0, Math.round(cov.pagesRead)) : 0,
      reachedEnd: cov.reachedEnd === true,
    };
  }

  /**
   * Assemble the batch the background worker posts.
   *
   * `signedIn: false` empties the rows rather than sending whatever a login page
   * happened to render. A login wall produces a not-signed-in report and no
   * observations, not a closet that appears to have emptied.
   */
  function buildBatch(input) {
    const i = input && typeof input === "object" ? input : {};
    const signedIn = i.signedIn !== false;
    const nowIso = clean(i.nowIso) || new Date(0).toISOString();

    if (!signedIn) {
      return {
        platform: clean(i.platform),
        observedAt: nowIso,
        signedIn: false,
        sold: [],
        closet: null,
      };
    }

    const sold = Array.isArray(i.soldRaw)
      ? i.soldRaw.map(function (r) { return buildSoldObservation(r, nowIso); })
      : [];

    return {
      platform: clean(i.platform),
      observedAt: nowIso,
      signedIn: true,
      // Only a read that actually enumerated the closet reports one. `undefined`
      // means "not read this pass", which the server treats as no evidence at
      // all — distinct from an empty closet, which is a selector failure.
      sold: sold,
      closet: i.closetRaw === undefined || i.closetRaw === null
        ? null
        : buildClosetObservation(i.closetRaw, i.coverage),
    };
  }

  root.GT_SYNC_OBSERVE = {
    ALLOWED_SOLD_FIELDS: ALLOWED_SOLD_FIELDS,
    canonicalUrl: canonicalUrl,
    parsePriceCents: parsePriceCents,
    parseSoldAt: parseSoldAt,
    buildSoldObservation: buildSoldObservation,
    buildClosetObservation: buildClosetObservation,
    buildBatch: buildBatch,
  };
})(typeof self !== "undefined" ? self : globalThis);
