// GradeThread Condition Check — pure result-formatting helpers (US-1884)
//
// DOM-free, dependency-free presentation logic for the condition overlay,
// factored out of the content script so it is unit-testable in node
// (test/condition-format.test.cjs) AND loadable as a classic content script
// (it sets self.GT_CC_FMT in the isolated world). Loaded as `.js` so Chrome
// accepts it (Chrome rejects .cjs content scripts); the UMD shim below still
// gives node's require() a module.exports.
//
// Everything here is a PURE function of the endpoint's already-returned data
// (factorScores + imagesAnalyzed) — no network, no DOM. The overlay renderer
// turns the returned rows into elements. Two invariants this file guarantees:
//   1. A NaN / non-finite / out-of-range factor score can NEVER be produced
//      (safeScore drops it) — so the overlay can't render "NaN". (AC5)
//   2. UI strings live in STRINGS, ready for a future _locales i18n pass;
//      translations are deferred but the extraction point is centralized. (AC5)

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_CC_FMT = api; // content-script world
})(typeof self !== "undefined" ? self : this, function () {
  // ── Centralized copy (US-1884 AC5: ready for _locales) ──────────────────
  //
  // EVERY user-facing string the condition overlay renders lives here, including
  // the ones that predate US-1884. That is the whole point: a _locales pass is a
  // mechanical job only if there is exactly one place to read the copy out of.
  // Half-centralized copy is worse than none, because the next author sees a
  // STRINGS table, assumes it is complete, and translates a subset.
  //
  // `{name}` placeholders are substituted by `fmt`. Interpolate through it rather
  // than concatenating around a string, or the word order becomes English-only
  // and no translator can fix it.
  //
  // Brand nouns ("GradeThread") are deliberately absent — a brand is not copy.
  const STRINGS = {
    // US-3066: the on-device quick look. These three sit HERE, with the rest of
    // the overlay's copy, rather than in research/local-model.js — that module
    // runs the model, and copy that decides how a shopper reads the result
    // belongs where the overlay's other wording is reviewed.
    //
    // THE RULE THEY EXIST UNDER: no number, no tier, and no bare use of the
    // word "grade". A quick look that reads like a grade IS one, to the person
    // looking at it, and it would be a grade with no prompt version, no eval
    // gate, no review threshold and no certificate behind it.
    // condition-format.test.cjs asserts both halves of that.
    quickLookLabel: "Quick look (on your device)",
    quickLookNote:
      "A first impression from a model running in your browser. It is not a " +
      "condition grade and nothing was sent anywhere.",
    quickLookEmpty: "Nothing obvious spotted in these photos.",
    // Factor breakdown + photo coverage.
    factorFabric: "Fabric",
    factorStructural: "Structural",
    factorCosmetic: "Cosmetic",
    factorFunctional: "Functional",
    factorOdor: "Odor",
    photosOne: "Graded from 1 photo",
    photosMany: "Graded from {n} photos",
    // US-3051: the reads left in the hour, from the server's own window.
    quotaLeft: "{remaining} of {limit} reads left this hour",
    quotaNone: "That was your last read for this hour",
    lowCoverageNudge:
      "Only a few photos to go on — ask the seller for more (a tag/label + close-up detail) for a fuller read.",
    factorsHeading: "Condition factors",

    // Chrome of the overlay.
    overlayBadge: "condition check",
    closeLabel: "Close GradeThread condition check",
    collapseLabel: "Collapse the condition check",
    expandLabel: "Expand the condition check",
    ownListingBadge: "your listing",

    // Launcher + loading.
    launcherLead: "Independent AI condition read on this {marketplace} listing.",
    launcherTargetFallback: "this listing",
    launcherCta: "Get condition read",
    loading: "Reading the listing photos…",

    // The read itself.
    savedRead: "Saved read · {when} — same grade as before.",
    confidence: "Confidence {pct}%",
    lowConfidence: "Low confidence from listing photos — grade it properly for a reliable read.",
    reread: "Re-read",
    tryAgain: "Try again",
    gradeProperly: "Grade it properly →",

    // Claimed-vs-objective discrepancy (US-1834).
    discOverGraded: "⚠ Seller may be over-grading",
    discMildGap: "Slightly better than photos support",
    discMatch: "✓ Matches the seller's stated condition",
    discDetail: "{verdict} (photos ≈ {objective} vs claimed ≈ {claimed})",

    // Price fairness (US-1835).
    priceLow: "✓ Priced below fair value — a deal",
    priceFair: "Priced fairly for its condition",
    priceHigh: "⚠ Priced above fair value",
    priceDetail: "{verdict} ({delta}% vs typical)",
    conditionAdjustedValue: "Condition-adjusted value: ${low}–${high}",

    // Point-of-purchase fraud flags (US-1836). The label itself comes from the
    // server; this is only the risk glyph that frames it.
    fraudFlag: "⚑ {label}",

    // Coverage-gap macro + handoffs (US-1837 / US-1838 / US-1839).
    askSellerFor: "For a confident grade, ask the seller for:",
    copyPhotoRequest: "Copy photo request",
    copyPhotoRequestDone: "Copied — paste it to the seller",
    copyPhotoRequestFailed: "Couldn't copy — select the list above",
    watchOnGradeThread: "Watch on GradeThread",
    fitLink: "Will it fit you? →",
    signInPrompt: "Sign in / upgrade →",

    // Failure states. Each says what the shopper can do about it.
    errNoPhotos:
      "Couldn't find this listing's photos. The site may have changed its layout — try reloading.",
    errInterrupted: "Something interrupted the read. Try again in a moment.",
    errQuota: "You've hit the free read limit for now. Try again later.",
    errCapacity: "GradeThread is at capacity right now. Try again later.",
    errGeneric: "Couldn't grade this listing right now.",

    // Surfaces the unified extension adds around the same overlay: the buyer's
    // alert check-in, the seller Flip panel and the search-grid badge. They live
    // in this table too because the two copies of this file are kept IDENTICAL —
    // a translator should read one table, not two that mostly agree.
    alertsCheck: "Check my alerts",
    alertsChecking: "Checking…",
    alertsChecked: "Checked",
    alertsFailed: "Couldn't check your alerts right now.",
    alertsNoMatch: "This one doesn't match any of your alerts.",
    alertsMatchOne: "Matches your alert: {names}",
    alertsMatchMany: "Matches {count} of your alerts: {names}",
    flipPlans: "See FlipDesk plans →",
    flipRecheck: "Re-check",
    badgeCta: "Read condition",

    // US-3068: the return shield. Every string a seller reads on an eBay
    // dispute page lives here, and there is one rule over all of them:
    //
    //   NOTHING PROMISES AN OUTCOME. No "wins", no "guaranteed", no "reversed".
    //   Evidence is evidence. A seller who reads "this will win" and then loses
    //   has been told something we had no business saying, on the day it costs
    //   them money. A test asserts those three words appear nowhere in here.
    //
    // The refusal copy is the most important of them. When the pack would argue
    // from a defect the listing never disclosed, the honest answer is that the
    // buyer has a point — so it says so and offers nothing to paste.
    shieldTitle: "GradeThread has a graded record for this item",
    shieldGradedOn: "Graded {date}",
    shieldDefects: "{n} recorded flaw(s)",
    shieldNoSnapshot:
      "We do not have a copy of the listing text as published, so this can only " +
      "speak to what the report recorded.",
    shieldRefusal:
      "The flaw being complained about is not one the listing disclosed. There " +
      "is nothing here that argues in your favour, and a refund is worth " +
      "considering.",
    shieldCopy: "Copy the wording",
    shieldCopied: "Copied",
    shieldOpen: "Open in FlipDesk",
    draftOpening: "The condition of this item was graded and recorded before sale:",
    disclosedInDescription: "Disclosed in the listing description as",
    disclosedInAspects: "Disclosed in the listing item specifics as",
    certificateLine: "The full graded report is certificate {n}.",

    // Relative times, for a recalled read.
    justNow: "just now",
    minutesAgo: "{n}m ago",
    hoursAgo: "{n}h ago",
    daysAgo: "{n}d ago",
  };

  /**
   * Substitute `{name}` placeholders. An unknown placeholder is left ALONE
   * rather than blanked: a visible `{when}` in the UI is a bug report, an empty
   * gap is a mystery. (US-1884 AC5)
   */
  function fmt(template, vars) {
    if (typeof template !== "string") return "";
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, function (whole, key) {
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole;
    });
  }

  // The five grade factors, in weight order (Fabric 30 / Structural 25 /
  // Cosmetic 20 / Functional 15 / Odor 10). `key` matches the endpoint's
  // factorScores object (ai-grading.ts FactorScores).
  const FACTORS = [
    { key: "fabric_condition", label: STRINGS.factorFabric },
    { key: "structural_integrity", label: STRINGS.factorStructural },
    { key: "cosmetic_appearance", label: STRINGS.factorCosmetic },
    { key: "functional_elements", label: STRINGS.factorFunctional },
    { key: "odor_cleanliness", label: STRINGS.factorOdor },
  ];

  // Grades run 1.0–10.0. Below this many analyzed photos we nudge for more.
  // Mirrors the server's COVERAGE_GAP_MIN_IMAGES (public-grading.ts).
  const LOW_COVERAGE_MAX_PHOTOS = 3;

  /**
   * Coerce a value to a finite grade in [1,10], or null. This is the single
   * NaN/garbage gate — anything not a real number in range becomes null so no
   * caller can render "NaN" or a nonsense bar. (US-1884 AC5)
   */
  function safeScore(v) {
    const n = typeof v === "number" ? v : Number(v);
    if (!isFinite(n)) return null;
    if (n < 1 || n > 10) return null;
    return n;
  }

  /** Bucket a 1–10 score into the overlay's severity class (mirrors scoreClass). */
  function scoreClass(score) {
    if (score >= 9) return "gt-cc-s-excellent";
    if (score >= 7) return "gt-cc-s-good";
    if (score >= 5) return "gt-cc-s-fair";
    if (score >= 3) return "gt-cc-s-poor";
    return "gt-cc-s-bad";
  }

  /**
   * Turn the endpoint's factorScores object into ordered, render-ready rows:
   * `{ key, label, score, pct, cls }`. Factors whose score is missing / NaN /
   * out of range are DROPPED (never rendered). Returns [] when nothing usable —
   * the caller then simply omits the factor section. (US-1884 AC1 + AC5)
   */
  function factorBars(factorScores) {
    if (!factorScores || typeof factorScores !== "object") return [];
    const rows = [];
    for (const f of FACTORS) {
      const score = safeScore(factorScores[f.key]);
      if (score === null) continue;
      rows.push({
        key: f.key,
        label: f.label,
        score: score,
        // Bar fill as a whole-number percentage of the 10-point scale.
        pct: Math.round((score / 10) * 100),
        cls: scoreClass(score),
      });
    }
    return rows;
  }

  /**
   * "Graded from N photo(s)" or null when the count isn't a positive integer.
   * (US-1884 AC1 — surfaces imagesAnalyzed, which the overlay dropped before.)
   */
  function photoCountLabel(imagesAnalyzed) {
    const n = typeof imagesAnalyzed === "number" ? imagesAnalyzed : Number(imagesAnalyzed);
    if (!isFinite(n) || n <= 0) return null;
    const whole = Math.floor(n);
    if (whole <= 0) return null;
    if (whole === 1) return STRINGS.photosOne;
    return fmt(STRINGS.photosMany, { n: whole });
  }

  /**
   * True when the read was based on few enough photos that a "ask for more"
   * nudge is worth showing. False for unknown / rich sets. (US-1884 AC1)
   */
  function lowCoverage(imagesAnalyzed) {
    const n = typeof imagesAnalyzed === "number" ? imagesAnalyzed : Number(imagesAnalyzed);
    if (!isFinite(n) || n <= 0) return false;
    return Math.floor(n) < LOW_COVERAGE_MAX_PHOTOS;
  }

  /**
   * A coarse "how long ago" label for a recalled read. Lives here rather than in
   * the content script so its copy sits in STRINGS with everything else the
   * overlay renders. `now` is injectable, so the test doesn't depend on a clock.
   * (US-1884 AC5)
   */
  function timeAgo(ts, now) {
    const then = Number(ts);
    const ref = typeof now === "number" && isFinite(now) ? now : Date.now();
    if (!isFinite(then)) return STRINGS.justNow;
    const seconds = Math.max(0, Math.floor((ref - then) / 1000));
    if (seconds < 60) return STRINGS.justNow;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return fmt(STRINGS.minutesAgo, { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return fmt(STRINGS.hoursAgo, { n: hours });
    return fmt(STRINGS.daysAgo, { n: Math.floor(hours / 24) });
  }

  return {
    STRINGS,
    FACTORS,
    LOW_COVERAGE_MAX_PHOTOS,
    fmt,
    safeScore,
    scoreClass,
    factorBars,
    photoCountLabel,
    lowCoverage,
    timeAgo,
  };
});
