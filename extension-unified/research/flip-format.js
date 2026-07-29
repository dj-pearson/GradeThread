// GradeThread unified extension — pure flip-mode formatting (US-2238)
//
// DOM-free, dependency-free presentation logic for the seller's sourcing panel,
// factored out of the content script so it is unit-testable in node
// (test/flip-format.test.cjs) AND loadable as a classic content script (it sets
// self.GT_CC_FLIP in the isolated world). Loaded as `.js` so Chrome accepts it;
// the UMD shim still gives node's require() a module.exports.
//
// ── WHAT THIS PANEL IS ────────────────────────────────────────────────────────
//
// The buyer overlay answers "is this item in the condition they claim?". Flip
// mode answers a different question for a different person: "if I buy this at
// the asking price and resell it, do I make money?".
//
// Three rules the formatting enforces, because each one is a way the panel could
// mislead the person acting on it:
//
//   1. NO MONEY WITHOUT COMPS. Every currency figure derives from the eBay comp
//      band. When the endpoint reports insufficientComps, the panel shows the
//      condition read and nothing else — a margin computed off two listings is
//      worse than no margin, because it looks equally precise.
//   2. THE VERDICT NEVER OUTRUNS ITS CONFIDENCE. decideBuy already refuses a
//      strong "buy" on a low-confidence grade; the copy has to say WHY, or a
//      "maybe" reads as a weak buy rather than as "we couldn't see it well".
//   3. IT IS A PRIVATE ESTIMATE. The shadow grade never leaves the tenant and is
//      never the seller's certificate (US-620). The panel says so.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_CC_FLIP = api; // content-script world
})(typeof self !== "undefined" ? self : this, function () {
  const STRINGS = {
    heading: "Flip check",
    cta: "Should I flip this?",
    working: "Pricing this against comps…",
    buy: "Buy",
    maybe: "Maybe",
    skip: "Pass",
    resale: "Resale at this condition",
    margin: "Margin after fees",
    breakeven: "Pay up to",
    sellThrough: "Expected to sell in",
    noComps: "Not enough comparable sales to price this honestly.",
    lowConfidence: "The listing photos aren't clear enough for a confident call.",
    upgrade: "Flip checks need an active FlipDesk plan.",
    quota: "You've used this month's AI actions.",
    privateNote: "Private estimate — never shown to the seller.",
  };

  const VERDICT = {
    buy: { label: STRINGS.buy, cls: "gt-cc-v-buy" },
    maybe: { label: STRINGS.maybe, cls: "gt-cc-v-maybe" },
    skip: { label: STRINGS.skip, cls: "gt-cc-v-skip" },
  };

  /**
   * Whole dollars from cents, or null.
   *
   * NO COERCION, deliberately. `Number(null)` is 0, so coercing here turned an
   * ABSENT margin — decideBuy returns estMarginCents:null when the listing had no
   * readable price — into a confident "+$0", a figure the reseller would read as
   * "this deal breaks even" rather than as "we don't know what it costs". Only a
   * real, finite number is money; everything else is null and the caller drops
   * the row entirely.
   */
  function money(cents) {
    if (typeof cents !== "number" || !isFinite(cents)) return null;
    const dollars = Math.round(cents / 100);
    return "$" + (Object.is(dollars, -0) ? 0 : dollars);
  }

  /** "$40–$85" from a value band, or null when the band is incomplete. */
  function rangeLabel(value) {
    if (!value || value.sufficient === false) return null;
    const low = money(value.lowCents);
    const high = money(value.highCents);
    if (low == null || high == null) return null;
    return low + "–" + high;
  }

  /**
   * "+$32 (160%)" — margin with its ROI, or null when no cost was known (the
   * listing had no readable price) or the margin isn't a real number.
   *
   * roiPct comes off decideBuy as a RATIO (0.3 = 30%), not a percentage, which is
   * exactly the kind of unit mismatch that ships a "30%" reading as "0.3%".
   */
  function marginLabel(decision) {
    if (!decision) return null;
    const m = money(decision.estMarginCents);
    if (m == null) return null;
    const sign = decision.estMarginCents > 0 ? "+" : "";
    if (typeof decision.roiPct !== "number" || !isFinite(decision.roiPct)) return sign + m;
    return sign + m + " (" + Math.round(decision.roiPct * 100) + "%)";
  }

  /** "7–21 days", or null when the forecast is unknown. */
  function sellThroughLabel(sellThrough) {
    if (!sellThrough || sellThrough.label === "unknown") return null;
    const lo = Number(sellThrough.daysLow);
    const hi = Number(sellThrough.daysHigh);
    if (!isFinite(lo) || !isFinite(hi) || hi <= 0) return null;
    return lo === hi ? hi + " days" : lo + "–" + hi + " days";
  }

  /**
   * Turn the endpoint's response into render-ready rows. Returns
   * { verdict, note, rows: [{label, value}] }. Rows are omitted entirely rather
   * than rendered empty — a "Margin: —" line invites the reader to fill in the
   * blank with an assumption.
   */
  function panelFor(data) {
    if (!data || typeof data !== "object") return null;

    const decision = data.decision;
    const verdict = decision && VERDICT[decision.recommendation]
      ? VERDICT[decision.recommendation]
      : null;

    const rows = [];
    // Rule 1: no money without comps. insufficientComps short-circuits every
    // currency row, including breakeven — which is derived from the same band.
    if (!data.insufficientComps) {
      const resale = rangeLabel(data.value);
      if (resale) rows.push({ label: STRINGS.resale, value: resale });
      const margin = marginLabel(decision);
      if (margin) rows.push({ label: STRINGS.margin, value: margin });
      const breakeven = decision && money(decision.breakevenCents);
      if (breakeven) rows.push({ label: STRINGS.breakeven, value: breakeven });
      const st = sellThroughLabel(data.sellThrough);
      if (st) rows.push({ label: STRINGS.sellThrough, value: st });
    }

    // Rule 2: name the reason the verdict is soft, rather than letting "maybe"
    // stand in for two different things.
    let note = "";
    if (data.insufficientComps) note = STRINGS.noComps;
    else if (decision && decision.confident === false) note = STRINGS.lowConfidence;

    return {
      verdict: verdict,
      // decideBuy writes its own one-line reason with the real figures in it;
      // prefer it over anything we'd reconstruct here.
      reason: (decision && typeof decision.reason === "string" && decision.reason) || "",
      note: note,
      rows: rows,
    };
  }

  /**
   * Listing price in CENTS from the price text already scraped for the buyer
   * overlay. Mirrors parsePriceCents on the edge (price-fairness.ts) so the cost
   * basis the panel shows is the one the server actually used. Returns null when
   * no price could be read — the panel then shows resale and sell-through but no
   * margin, which is the honest degrade.
   */
  function priceToCents(raw) {
    if (typeof raw !== "string") return null;
    const m = raw.replace(/[, ]/g, "").match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const dollars = parseFloat(m[1]);
    return isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 100) : null;
  }

  return {
    STRINGS,
    VERDICT,
    money,
    rangeLabel,
    marginLabel,
    sellThroughLabel,
    panelFor,
    priceToCents,
  };
});
