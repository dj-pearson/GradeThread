// GradeThread Condition Check — pure search-page scan helpers (US-2237)
//
// DOM-free, dependency-free logic for scan mode, factored out of the content
// script so it is unit-testable in node (test/scan-format.test.cjs) AND loadable
// as a classic content script (it sets self.GT_CC_SCAN in the isolated world).
// Loaded as `.js` so Chrome accepts it (Chrome rejects .cjs content scripts);
// the UMD shim below still gives node's require() a module.exports.
//
// ── THE ONE RULE THIS FILE ENFORCES ──────────────────────────────────────────
//
// A search-results card badge is NOT a grade. Nothing on a search page has been
// looked at by the grader — no photo was fetched, no Vision call was made. What
// the badge reports is the seller's OWN claimed condition and how the asking
// price sits against comps for that claim.
//
// A number between 1.0 and 10.0 on a result card would be read as a GradeThread
// grade by every shopper who has ever seen the detail overlay, and it would be
// wrong. So badgeFor NEVER emits a numeric score and never emits the word
// "grade"; the claim is rendered as the seller's own tier word, attributed to
// them ("seller: like new"). test/scan-format.test.cjs asserts both, over the
// whole string table, so a future copy edit can't quietly reintroduce it.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_CC_SCAN = api; // content-script world
})(typeof self !== "undefined" ? self : this, function () {
  // ── Centralized copy (mirrors condition-format.js STRINGS, i18n-ready) ─────
  const STRINGS = {
    priceLow: "Under typical",
    priceFair: "Typical price",
    priceHigh: "Over typical",
    claimPrefix: "seller: ",
    thinPhotos: "few photos",
    scanningLabel: "Checking listings…",
    // Shown once per page, not per card — the per-card badges are deliberately
    // terse and this is where the "no photos were analysed" caveat lives.
    footnote: "Claimed condition and price only. Open a listing for a real condition read.",
  };

  // Cards we'll send in one scan request. Mirrors MAX_SCAN_CARDS in
  // services/edge-functions/src/routes/public-grading.ts — the server caps too,
  // so this only avoids posting a payload we know will be trimmed.
  const MAX_CARDS = 24;

  // The seller's claimed condition expressed as THEIR word, not our number.
  // Buckets match condition-discrepancy.ts's LABEL_GRADE representative grades
  // so "New with tags" (10) round-trips back to "new with tags" rather than to
  // some nearby tier the seller never claimed.
  const CLAIM_LABELS = [
    { min: 9.5, label: "new with tags" },
    { min: 8.5, label: "new without tags" },
    { min: 7.5, label: "like new" },
    { min: 6.5, label: "very good" },
    { min: 5.5, label: "good" },
    { min: 3.5, label: "fair" },
    { min: 1, label: "poor" },
  ];

  /**
   * The seller's claimed condition as a word. null for anything we couldn't read
   * off the card — an absent claim renders NOTHING rather than a guess, because
   * only eBay reliably prints a condition on its result cards.
   */
  function claimLabel(claimedGrade) {
    const n = typeof claimedGrade === "number" ? claimedGrade : Number(claimedGrade);
    if (!isFinite(n) || n < 1 || n > 10) return null;
    for (const row of CLAIM_LABELS) {
      if (n >= row.min) return row.label;
    }
    return null;
  }

  /**
   * Render-ready badge for one scanned card, or null when there is nothing
   * honest to say (no readable claim, no price verdict, no photo signal). null
   * means "draw no badge" — an empty pill on every card of a grid we couldn't
   * read is worse than no feature at all.
   *
   * Returns { parts: [{ text, cls }], cls } where cls is the badge's overall
   * severity, so the caller only walks a list and never re-derives copy.
   */
  function badgeFor(card) {
    if (!card || typeof card !== "object") return null;
    const parts = [];

    const claim = claimLabel(card.claimedGrade);
    if (claim) parts.push({ text: STRINGS.claimPrefix + claim, cls: "gt-cc-b-claim" });

    let severity = "gt-cc-b-neutral";
    if (card.fairness === "low") {
      parts.push({ text: STRINGS.priceLow, cls: "gt-cc-b-good" });
      severity = "gt-cc-b-good";
    } else if (card.fairness === "high") {
      parts.push({ text: STRINGS.priceHigh, cls: "gt-cc-b-bad" });
      severity = "gt-cc-b-bad";
    } else if (card.fairness === "fair") {
      parts.push({ text: STRINGS.priceFair, cls: "gt-cc-b-neutral" });
    }
    // 'unknown' adds nothing: comps were thin or absent, and a shrug rendered as
    // a badge reads as a verdict.

    if (card.thinPhotos === true) {
      parts.push({ text: STRINGS.thinPhotos, cls: "gt-cc-b-warn" });
      if (severity === "gt-cc-b-neutral") severity = "gt-cc-b-warn";
    }

    if (!parts.length) return null;
    return { parts: parts, cls: severity };
  }

  /**
   * The search query for the whole grid, from the page URL. Every card on a
   * results page answers the SAME query, so this is resolved once and comps are
   * pulled against it — per-card titles would fan the comp lookups out into
   * noise. Returns "" when no configured param carries one.
   */
  function searchQueryFrom(href, queryParams) {
    if (typeof href !== "string" || !href) return "";
    let url;
    try {
      url = new URL(href);
    } catch (_e) {
      return "";
    }
    for (const name of queryParams || []) {
      const v = url.searchParams.get(String(name));
      if (v && v.trim()) return v.trim().slice(0, 200);
    }
    return "";
  }

  /**
   * A stable id for a result card, so the response can be matched back to the
   * DOM node it came from. Keyed on the listing href (origin + path, query
   * dropped) — the same identity rule marketplace.js uses for the per-listing
   * grade cache, so a card and its detail page agree. Falls back to the index
   * when a card has no resolvable link.
   */
  function cardKey(href, index) {
    if (typeof href === "string" && href) {
      try {
        const u = new URL(href);
        return (u.origin + u.pathname).toLowerCase().replace(/\/+$/, "");
      } catch (_e) { /* relative or malformed — fall through to the index */ }
    }
    return "idx:" + index;
  }

  /**
   * Drop cards we can't act on and cap to MAX_CARDS. A card with no link is
   * unclickable, so a badge on it would advertise an action that does nothing.
   */
  function usableCards(cards, max) {
    const limit = typeof max === "number" && max > 0 ? max : MAX_CARDS;
    const out = [];
    const seen = new Set();
    for (const c of cards || []) {
      if (!c || typeof c !== "object" || !c.key || !c.href) continue;
      if (seen.has(c.key)) continue; // grids repeat promoted listings
      seen.add(c.key);
      out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }

  return {
    STRINGS,
    MAX_CARDS,
    CLAIM_LABELS,
    claimLabel,
    badgeFor,
    searchQueryFrom,
    cardKey,
    usableCards,
  };
});
