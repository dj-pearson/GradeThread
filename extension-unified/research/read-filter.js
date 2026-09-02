// GradeThread unified extension — filtering the read history (US-3057).
//
// Pure, DOM-free, no chrome.*: the popup keeps the whole history in memory
// and narrows it here on every keystroke, so a filter never costs a storage
// round trip. Loadable as a classic script (self.GT_READ_FILTER) and by
// node's require() for test/read-filter.test.cjs.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof root !== "undefined") root.GT_READ_FILTER = api;
})(typeof self !== "undefined" ? self : this, function () {
  // How many rows the popup paints. A hundred rows of rings and tags is the
  // difference between a popup that opens and one that stutters; the rest are
  // one filter away, and the note under the list says how many there are.
  const RENDER_CAP = 40;

  function norm(s) {
    return String(s == null ? "" : s).toLowerCase().trim();
  }

  /** The marketplaces present in the history, most reads first, then by name. */
  function marketplacesOf(reads) {
    const counts = new Map();
    for (const r of Array.isArray(reads) ? reads : []) {
      const m = norm(r && r.marketplace);
      if (!m) continue;
      counts.set(m, (counts.get(m) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, count]) => ({ key, count }));
  }

  /**
   * Narrow `reads` by a free-text query (title or seller, case-insensitive,
   * every whitespace-separated word must match somewhere) and a marketplace
   * set (empty set = all). Order is preserved. Never mutates the input.
   */
  function filterReads(reads, opts) {
    const list = Array.isArray(reads) ? reads : [];
    const o = opts || {};
    const words = norm(o.q).split(/\s+/).filter(Boolean);
    const markets = new Set((Array.isArray(o.marketplaces) ? o.marketplaces : []).map(norm).filter(Boolean));
    return list.filter((r) => {
      if (!r || typeof r !== "object") return false;
      if (markets.size && !markets.has(norm(r.marketplace))) return false;
      if (!words.length) return true;
      const hay = norm(r.title) + " " + norm(r.seller);
      return words.every((w) => hay.includes(w));
    });
  }

  /** What an empty result should say: names the filters, never "no reads yet". */
  function emptyCopy(opts, total) {
    const o = opts || {};
    const q = norm(o.q);
    const markets = Array.isArray(o.marketplaces) ? o.marketplaces.filter(Boolean) : [];
    const parts = [];
    if (q) parts.push('"' + String(o.q).trim() + '"');
    if (markets.length) parts.push(markets.join(", "));
    if (!parts.length) return null; // nothing filtered: the caller shows its own empty state
    return "None of your " + total + " read" + (total === 1 ? "" : "s") + " match " + parts.join(" on ") + ". Clear the filter to see them all.";
  }

  return { RENDER_CAP, filterReads, marketplacesOf, emptyCopy };
});
