// GradeThread unified extension — the compare tray (US-2240)
//
// DOM-free, dependency-free tray logic, factored out so it is unit-testable in
// node (test/compare-tray.test.cjs) AND loadable as a classic script by the
// content script, the worker and compare.html alike (it sets self.GT_CC_TRAY).
// The UMD shim gives node's require() a module.exports.
//
// ── WHY A TRAY ───────────────────────────────────────────────────────────────
//
// The overlay grades ONE listing at a time and then forgets it. But nobody buys
// one listing — they choose between six of the same jacket, in six tabs, at six
// prices. Every read the shopper already paid for is thrown away the moment they
// click through to the next candidate, so the comparison they are actually
// making happens in their head, from memory.
//
// The tray is that comparison written down. It stores the grade payload the
// endpoint ALREADY returned, so pinning costs nothing — no second call, no
// second Vision spend, no quota. That is also why the tray can only hold reads:
// pinning an ungraded listing would either mean grading it silently (spending
// the shopper's quota on a button that doesn't say so) or storing a blank row.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_CC_TRAY = api; // content / popup / page
})(typeof self !== "undefined" ? self : this, function () {
  const KEY = "compareTray";
  // Six is the point past which a side-by-side stops being readable in a popup
  // and starts being a spreadsheet. Oldest out, so pinning a seventh keeps the
  // shopper's most recent thinking rather than refusing the click.
  const MAX = 6;

  const STRINGS = {
    pin: "Pin to compare",
    pinned: "Pinned",
    unpin: "Unpin",
    open: "Compare",
    empty: "Nothing pinned yet. Read a listing, then pin it to line it up against others.",
    heading: "Compare",
    clear: "Clear all",
    noPrice: "—",
    // US-3056
    bestValue: "Best value",
    noPriceNote: "no price read",
    copySummary: "Copy summary",
    copied: "Copied",
    copyFailed: "Couldn't copy — select the table instead",
  };

  /** Same normalisation the grade cache uses, so a tray row and a listing agree. */
  function keyFor(href) {
    if (typeof href !== "string" || !href) return null;
    try {
      const u = new URL(href);
      return (u.origin + u.pathname).toLowerCase().replace(/\/+$/, "");
    } catch (_e) {
      return null;
    }
  }

  /** A finite grade in [1,10] or null — the single NaN gate, as in US-1884. */
  function safeScore(v) {
    const n = typeof v === "number" ? v : Number(v);
    if (!isFinite(n) || n < 1 || n > 10) return null;
    return n;
  }

  /**
   * Build a tray row from a listing + the grade payload already in hand. Returns
   * null when there is no usable identity — a row we can't link back to is a
   * dead line in the table.
   *
   * The whole row is a SNAPSHOT. It deliberately does not re-derive anything at
   * render time: the shopper pinned what they were shown, and a row that
   * silently recomputed itself later would no longer be the thing they compared.
   */
  function makeEntry(listing, data, now) {
    const key = keyFor(listing && listing.url);
    if (!key) return null;
    return {
      key: key,
      url: String((listing && listing.url) || ""),
      title: String((listing && listing.title) || "").slice(0, 200),
      marketplace: String((listing && listing.marketplace) || "").slice(0, 24),
      seller: typeof (listing && listing.seller) === "string" && listing.seller
        ? listing.seller.slice(0, 80)
        : null,
      priceText: String((listing && listing.priceText) || "").slice(0, 40),
      thumbUrl: typeof (listing && listing.thumbUrl) === "string" ? listing.thumbUrl : null,
      overallScore: safeScore(data && data.overallScore),
      gradeTier: String((data && data.gradeTier) || ""),
      confidence: typeof (data && data.confidence) === "number" && isFinite(data.confidence)
        ? data.confidence
        : null,
      imagesAnalyzed: typeof (data && data.imagesAnalyzed) === "number" ? data.imagesAnalyzed : null,
      fairness: (data && data.priceFairness && data.priceFairness.verdict) || "unknown",
      at: Number(now) || 0,
    };
  }

  /**
   * Add an entry, replacing any existing pin of the SAME listing (a re-read
   * should update the row, not create a duplicate the shopper then compares
   * against itself). Oldest-out at MAX. Pure: takes and returns the list.
   */
  function put(list, entry) {
    if (!entry || !entry.key) return Array.isArray(list) ? list.slice() : [];
    const out = (Array.isArray(list) ? list : []).filter((e) => e && e.key !== entry.key);
    out.push(entry);
    return out.length > MAX ? out.slice(out.length - MAX) : out;
  }

  function remove(list, key) {
    return (Array.isArray(list) ? list : []).filter((e) => e && e.key !== key);
  }

  function has(list, key) {
    return (Array.isArray(list) ? list : []).some((e) => e && e.key === key);
  }

  /**
   * Sort for the compare view. "score" is descending (best condition first) and
   * "price" ascending (cheapest first) — each field's useful direction, rather
   * than one rule applied to both.
   *
   * Rows MISSING the sort field always sink to the bottom regardless of
   * direction. A listing with no readable price is not "the cheapest".
   */
  function sortRows(rows, by) {
    const list = (Array.isArray(rows) ? rows : []).slice();
    if (by === "price") {
      return list.sort((a, b) => {
        const pa = priceCents(a), pb = priceCents(b);
        if (pa == null && pb == null) return (b.at || 0) - (a.at || 0);
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pa - pb;
      });
    }
    if (by === "score") {
      return list.sort((a, b) => {
        const sa = a && a.overallScore, sb = b && b.overallScore;
        if (sa == null && sb == null) return (b.at || 0) - (a.at || 0);
        if (sa == null) return 1;
        if (sb == null) return -1;
        return sb - sa;
      });
    }
    // Default: most recently pinned first — the order the shopper built.
    return list.sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  /** Cents from the stored price text. Mirrors the server's parser. */
  function priceCents(entry) {
    const raw = entry && entry.priceText;
    if (typeof raw !== "string") return null;
    const m = raw.replace(/[, ]/g, "").match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const dollars = parseFloat(m[1]);
    return isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 100) : null;
  }

  /**
   * US-3056: the key of the row worth buying — the highest condition per
   * dollar among rows that have BOTH a score and a parsed price. Ties go to
   * the higher score (same value per dollar, better garment), then to the
   * earlier pin. Null when fewer than two rows qualify: "best of one" is not a
   * comparison, and a tag on a lone row reads as a recommendation it is not.
   */
  function bestValueKey(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let best = null;
    let bestRatio = -Infinity;
    let qualified = 0;
    for (const r of list) {
      const cents = priceCents(r);
      const score = r && typeof r.overallScore === "number" && isFinite(r.overallScore) ? r.overallScore : null;
      if (cents === null || cents <= 0 || score === null) continue;
      qualified++;
      const ratio = score / (cents / 100);
      if (ratio > bestRatio || (ratio === bestRatio && best && score > best.overallScore)) {
        best = r;
        bestRatio = ratio;
      }
    }
    return qualified >= 2 && best ? best.key : null;
  }

  /**
   * US-3056: the tray as plain text, one line per row, for pasting into a
   * message. Built from the stored snapshot only — nothing is fetched and
   * nothing leaves the device until the shopper pastes it somewhere.
   */
  function summaryText(rows, marketplaceLabels) {
    const list = Array.isArray(rows) ? rows : [];
    const labels = marketplaceLabels || {};
    const bestKey = bestValueKey(list);
    const lines = list.map((r) => {
      const bits = [
        r.title || "Listing",
        labels[r.marketplace] || r.marketplace || "",
        "grade " + scoreLabel(r),
        r.priceText || STRINGS.noPrice,
      ];
      const fair = fairnessLabel(r);
      if (fair) bits.push(fair.toLowerCase());
      if (r.key === bestKey) bits.push(STRINGS.bestValue.toLowerCase());
      return "- " + bits.filter(Boolean).join(" | ");
    });
    return lines.join("\n");
  }

  /** Display score, or an em dash. Never "NaN" (US-1884 AC5, same rule). */
  function scoreLabel(entry) {
    const s = entry && entry.overallScore;
    return s == null ? "—" : s.toFixed(1);
  }

  /** Severity class for a score, mirroring the overlay's scale. */
  function scoreClass(score) {
    if (score == null) return "gt-cc-s-none";
    if (score >= 9) return "gt-cc-s-excellent";
    if (score >= 7) return "gt-cc-s-good";
    if (score >= 5) return "gt-cc-s-fair";
    if (score >= 3) return "gt-cc-s-poor";
    return "gt-cc-s-bad";
  }

  const FAIRNESS_LABEL = {
    low: "Under typical",
    fair: "Typical",
    high: "Over typical",
  };

  /** Price-fairness wording, or "" when the endpoint had no verdict. */
  function fairnessLabel(entry) {
    return FAIRNESS_LABEL[entry && entry.fairness] || "";
  }

  return {
    KEY,
    MAX,
    STRINGS,
    FAIRNESS_LABEL,
    keyFor,
    makeEntry,
    put,
    remove,
    has,
    sortRows,
    priceCents,
    scoreLabel,
    scoreClass,
    fairnessLabel,
    bestValueKey,
    summaryText,
  };
});
