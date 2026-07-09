// GradeThread Condition Check — pure image-URL helpers (US-1755)
//
// DOM-free, dependency-free string logic, factored out of the content script so
// it is unit-testable in node (test/ebay-image.test.cjs) AND loadable as a
// classic content script (it sets self.GT_EBAY_IMAGE in the isolated world).
// Loaded as a `.cjs` so node's `require()` sees module.exports even though the
// repo is an ESM package; Chrome loads it as a plain script regardless of the
// file extension.

(function (root, factory) {
  const api = factory();
  // node / CommonJS (the test)
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  // browser content-script isolated world
  if (typeof root !== "undefined") root.GT_EBAY_IMAGE = api;
})(typeof self !== "undefined" ? self : this, function () {
  // eBay CDN URLs embed a size token, e.g. .../s-l64.jpg, .../s-l500.webp,
  // .../s-l140_2.jpg. Thumbnails are tiny (s-l64/140) and grade poorly, so we
  // rewrite the token to the largest eBay serves (s-l1600). Anything without the
  // token (or a non-eBay host) is returned unchanged.
  function upgradeEbayImageUrl(url) {
    if (typeof url !== "string" || !url) return url;
    // Only touch eBay's image CDN so we never rewrite an unrelated URL.
    if (!/(^|\.)ebayimg\.com\//.test(url) && !/ebayimg\.com\//.test(url)) return url;
    // s-l<digits> optionally followed by _<digits> (variant suffix), before the
    // file extension. Replace the whole token with the max size, dropping the
    // variant suffix.
    return url.replace(/\/s-l\d+(?:_\d+)?(\.[a-z0-9]+)(?=($|\?))/i, "/s-l1600$1");
  }

  // Given raw attribute candidates for one <img>, pick the first non-empty,
  // absolute-looking http(s) URL. (Elements may carry lazy-load placeholders in
  // `src` and the real URL in `data-zoom-src`.)
  function pickImageUrl(candidates) {
    for (const raw of candidates || []) {
      if (typeof raw !== "string") continue;
      const v = raw.trim();
      if (!v) continue;
      if (/^https?:\/\//i.test(v)) return v;
    }
    return null;
  }

  // Dedupe upgraded URLs while preserving order, and cap to `limit` (the
  // endpoint accepts at most 4). eBay repeats the same photo across the main
  // carousel and the filmstrip, so after upgrading to s-l1600 many collapse to
  // one URL.
  function dedupeUrls(urls, limit) {
    const out = [];
    const seen = new Set();
    for (const u of urls || []) {
      if (typeof u !== "string" || !u) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (typeof limit === "number" && out.length >= limit) break;
    }
    return out;
  }

  return { upgradeEbayImageUrl, pickImageUrl, dedupeUrls };
});
