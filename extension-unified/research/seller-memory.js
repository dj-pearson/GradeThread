// GradeThread unified extension — buyer-private seller memory (US-2239)
//
// DOM-free, dependency-free aggregation over the shopper's OWN stored reads,
// factored out so it is unit-testable in node (test/seller-memory.test.cjs) AND
// loadable as a classic content script / background dep (it sets
// self.GT_CC_SELLER). The UMD shim gives node's require() a module.exports.
//
// ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────
//
// Every read the extension has ever done is a one-off. Grade this listing, close
// the overlay, forget it. But a seller who rounds every item up a tier does it
// on ALL their listings, and that pattern is sitting unused in the shopper's own
// recentReads the whole time.
//
// This computes that pattern. It is NOT a seller reputation system:
//
//   • It is BUYER-PRIVATE. The aggregate is computed from this install's
//     storage.local and nothing else. No seller handle is ever sent to a
//     GradeThread endpoint, and nothing is written to reputation_events or
//     buyer_trust_scores — US-2148 is explicit that a seller-adverse score needs
//     its own model and a human-confirmed basis, and this has neither.
//   • It is an OBSERVATION, not an accusation. The copy says what the shopper
//     themselves found ("your 4 reads average 1.8 below claimed"), never that a
//     seller is dishonest. sellerCopy is the only place that phrasing lives and
//     the test asserts the whole surface stays clear of fraud/scam wording.
//   • It REFUSES to speak from one sample. Below MIN_READS the answer is null —
//     one read of one item is a coincidence, and rendering it as a pattern is
//     how a single bad photo set becomes a verdict about a person.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_CC_SELLER = api; // content script + worker
})(typeof self !== "undefined" ? self : this, function () {
  // One read is an anecdote. Two is the floor at which "pattern" is even an
  // honest word, and it is still hedged in the copy.
  const MIN_READS = 2;

  // Below this average gap (in grade points) the seller is calling it about
  // right, and saying anything would manufacture a complaint out of rounding.
  const NOTABLE_GAP = 0.5;

  const STRINGS = {
    // {n} reads, {gap} average points below what the seller claimed.
    below: "Your {n} reads of this seller average {gap} below their stated condition.",
    above: "Your {n} reads of this seller came in {gap} above their stated condition.",
    inline: "Your {n} reads of this seller line up with their stated conditions.",
    heading: "By seller",
    noneYet: "No repeat sellers yet — read a second listing from someone to see a pattern.",
  };

  /**
   * A stable identity for a marketplace seller. Case- and whitespace-normalised
   * so "TheThriftCo" and "thethriftco " are one seller, and namespaced by
   * marketplace so an eBay handle can never merge with an identical Poshmark
   * one. Returns null for anything unusable — a listing whose seller we could
   * not read is stored with seller null and simply never aggregates.
   */
  function sellerKey(marketplace, handle) {
    if (typeof handle !== "string") return null;
    const h = handle.trim().toLowerCase().replace(/\s+/g, " ");
    if (!h || h.length > 80) return null;
    const m = typeof marketplace === "string" && marketplace.trim()
      ? marketplace.trim().toLowerCase()
      : "unknown";
    return m + ":" + h;
  }

  /** A finite grade in [1,10], or null. Same gate as condition-format.safeScore. */
  function safeScore(v) {
    const n = typeof v === "number" ? v : Number(v);
    if (!isFinite(n) || n < 1 || n > 10) return null;
    return n;
  }

  /**
   * Aggregate the shopper's stored reads for ONE seller.
   *
   * Returns { reads, avgOverall, avgClaimedDelta, lastAt } or null when there
   * aren't enough usable reads. avgClaimedDelta is signed and expressed as
   * (our read - their claim): negative means the item read WORSE than claimed,
   * which is the direction a shopper cares about.
   *
   * Reads with no claimedGrade still count toward `reads` and avgOverall — the
   * shopper did look at them — but only reads carrying BOTH numbers can produce
   * a delta, so the two counts are tracked separately rather than one standing
   * in for the other.
   */
  function aggregate(reads) {
    if (!Array.isArray(reads) || reads.length === 0) return null;
    let overallSum = 0;
    let overallCount = 0;
    let deltaSum = 0;
    let deltaCount = 0;
    let lastAt = 0;

    for (const r of reads) {
      if (!r || typeof r !== "object") continue;
      const overall = safeScore(r.overallScore);
      if (overall != null) {
        overallSum += overall;
        overallCount += 1;
      }
      const claimed = safeScore(r.claimedGrade);
      if (overall != null && claimed != null) {
        deltaSum += overall - claimed;
        deltaCount += 1;
      }
      const at = Number(r.at);
      if (isFinite(at) && at > lastAt) lastAt = at;
    }

    if (overallCount < MIN_READS) return null;
    return {
      reads: overallCount,
      avgOverall: round1(overallSum / overallCount),
      // null, not 0: "we have no claim data" and "they claim it accurately" are
      // different answers and 0 would render as the second.
      avgClaimedDelta: deltaCount > 0 ? round1(deltaSum / deltaCount) : null,
      deltaReads: deltaCount,
      lastAt: lastAt || null,
    };
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  /**
   * The single line the overlay shows, or null when there is nothing worth
   * saying. This is the ONLY place seller-pattern copy is produced, so the
   * "observation, never accusation" rule has exactly one place to hold.
   */
  function sellerCopy(agg) {
    if (!agg || agg.reads < MIN_READS) return null;
    const delta = agg.avgClaimedDelta;
    if (delta == null) return null; // no claims to compare against
    const gap = Math.abs(delta);
    if (gap < NOTABLE_GAP) {
      return STRINGS.inline.replace("{n}", String(agg.reads));
    }
    const template = delta < 0 ? STRINGS.below : STRINGS.above;
    return template
      .replace("{n}", String(agg.reads))
      .replace("{gap}", gap.toFixed(1) + (gap === 1 ? " point" : " points"));
  }

  /**
   * Group a flat recentReads list into per-seller rows for the popup, newest
   * first. Reads with no seller are omitted entirely — a "(no seller)" bucket
   * would pool unrelated listings into one meaningless average.
   */
  function groupBySeller(recentReads) {
    const byKey = new Map();
    for (const r of Array.isArray(recentReads) ? recentReads : []) {
      if (!r || typeof r !== "object") continue;
      const key = sellerKey(r.marketplace, r.seller);
      if (!key) continue;
      const entry = byKey.get(key);
      if (entry) entry.reads.push(r);
      else {
        byKey.set(key, {
          key: key,
          marketplace: String(r.marketplace || ""),
          seller: String(r.seller || ""),
          reads: [r],
        });
      }
    }
    const rows = [];
    for (const entry of byKey.values()) {
      const agg = aggregate(entry.reads);
      if (!agg) continue; // single-read sellers are not a pattern
      rows.push({
        key: entry.key,
        marketplace: entry.marketplace,
        seller: entry.seller,
        stats: agg,
        copy: sellerCopy(agg),
      });
    }
    rows.sort((a, b) => (b.stats.lastAt || 0) - (a.stats.lastAt || 0));
    return rows;
  }

  return {
    MIN_READS,
    NOTABLE_GAP,
    STRINGS,
    sellerKey,
    aggregate,
    sellerCopy,
    groupBySeller,
  };
});
