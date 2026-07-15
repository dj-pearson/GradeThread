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
  const STRINGS = {
    factorFabric: "Fabric",
    factorStructural: "Structural",
    factorCosmetic: "Cosmetic",
    factorFunctional: "Functional",
    factorOdor: "Odor",
    photosOne: "Graded from 1 photo",
    // {n} is substituted by photoCountLabel.
    photosMany: "Graded from {n} photos",
    lowCoverageNudge:
      "Only a few photos to go on — ask the seller for more (a tag/label + close-up detail) for a fuller read.",
    factorsHeading: "Condition factors",
  };

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
    return STRINGS.photosMany.replace("{n}", String(whole));
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

  return {
    STRINGS,
    FACTORS,
    LOW_COVERAGE_MAX_PHOTOS,
    safeScore,
    scoreClass,
    factorBars,
    photoCountLabel,
    lowCoverage,
  };
});
