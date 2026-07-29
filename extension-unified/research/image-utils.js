// GradeThread Condition Check — pure image/URL helpers (US-1755, US-1756)
//
// DOM-free, dependency-free string logic, factored out of the content script so
// it is unit-testable in node (test/image-utils.test.cjs) AND loadable as a
// classic content script (it sets self.GT_CC_IMG in the isolated world). Loaded
// as `.cjs` so node's require() sees module.exports even though the repo is an
// ESM package; Chrome loads it as a plain script regardless of extension.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_CC_IMG = api; // content-script world
})(typeof self !== "undefined" ? self : this, function () {
  // US-1756: per-adapter image-URL upgrade is config-driven — each marketplace
  // CDN encodes size differently, so instead of hardcoding one site's rule we
  // apply the adapter's {pattern, replacement, flags} regex. eBay's rule, for
  // example, is `/s-l\d+(?:_\d+)?(\.ext)` -> `/s-l1600$1`. The config comes from
  // OUR trusted gradethread.com host; a bad pattern is caught and the original
  // URL is returned unchanged (never throws into the extraction loop).
  function applyUrlUpgrade(url, upgrade) {
    if (typeof url !== "string" || !url) return url;
    if (!upgrade || typeof upgrade.pattern !== "string" || typeof upgrade.replacement !== "string") {
      return url;
    }
    let re;
    try {
      re = new RegExp(upgrade.pattern, typeof upgrade.flags === "string" ? upgrade.flags : "");
    } catch (_e) {
      return url; // malformed pattern — leave the URL as-is
    }
    try {
      return url.replace(re, upgrade.replacement);
    } catch (_e) {
      return url;
    }
  }

  // Given raw attribute candidates for one <img>, pick the first non-empty,
  // absolute http(s) URL. (Elements may carry a lazy-load placeholder in `src`
  // and the real image in a data-* attribute.)
  function pickImageUrl(candidates) {
    for (const raw of candidates || []) {
      if (typeof raw !== "string") continue;
      const v = raw.trim();
      if (!v) continue;
      if (/^https?:\/\//i.test(v)) return v;
    }
    return null;
  }

  // Dedupe URLs preserving order and cap to `limit` (the endpoint accepts at
  // most 4). Marketplaces repeat the same photo across a main view + a
  // filmstrip; after upgrading to full size many collapse to one URL.
  // US-2241: `assetIdPattern` (optional, per adapter) is a regex whose FIRST
  // capture group is the CDN's stable id for a photo. Without it, the same shot
  // served at two sizes is two different URLs and survives dedupe — so on a
  // gallery that emits both a thumbnail strip and a main image, one photo could
  // occupy two of the four slots and the read lost a quarter of its evidence.
  // Matching on the asset id collapses those. A pattern that doesn't match (or
  // is absent, or is malformed) falls back to plain URL identity, so a bad
  // remote pattern can never make photos vanish.
  function dedupeUrls(urls, limit, assetIdPattern) {
    let re = null;
    if (typeof assetIdPattern === "string" && assetIdPattern) {
      try {
        re = new RegExp(assetIdPattern, "i");
      } catch (_e) {
        re = null; // malformed remote pattern — degrade to URL identity
      }
    }
    const out = [];
    const seen = new Set();
    for (const u of urls || []) {
      if (typeof u !== "string" || !u) continue;
      let identity = u;
      if (re) {
        try {
          const m = re.exec(u);
          if (m && m[1]) identity = "asset:" + m[1];
        } catch (_e) { /* keep URL identity */ }
      }
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push(u);
      if (typeof limit === "number" && out.length >= limit) break;
    }
    return out;
  }

  // Resolve the adapter whose `hosts` list matches a page host. Matches on exact
  // host or dotted suffix (so "www.ebay.com" and "ebay.com" both match "ebay.com").
  function resolveAdapter(adapters, host) {
    if (!adapters || typeof adapters !== "object" || typeof host !== "string") return null;
    const h = host.toLowerCase();
    for (const key of Object.keys(adapters)) {
      const a = adapters[key];
      const hosts = (a && a.hosts) || [];
      for (const cand of hosts) {
        const c = String(cand).toLowerCase();
        if (h === c || h.endsWith("." + c)) return Object.assign({ key }, a);
      }
    }
    return null;
  }

  // Does `pathname` match a `detect` block ({ pathIncludes, pathRegex })? Shared
  // by the detail-page and (US-2237) the search-page test so the two can't drift.
  function matchesDetect(detect, pathname) {
    if (!detect || typeof pathname !== "string") return false;
    if (
      Array.isArray(detect.pathIncludes) &&
      detect.pathIncludes.some((p) => pathname.includes(p))
    ) {
      return true;
    }
    if (typeof detect.pathRegex === "string") {
      try {
        return new RegExp(detect.pathRegex).test(pathname);
      } catch (_e) {
        return false;
      }
    }
    return false;
  }

  // Is `pathname` a detail/item page for this adapter? True when it contains any
  // of detect.pathIncludes, or matches detect.pathRegex.
  function isDetailPage(adapter, pathname) {
    return matchesDetect(adapter && adapter.detect, pathname);
  }

  // US-2237: is `pathname` a SEARCH/browse results page for this adapter? Keyed
  // on the adapter's separate `search.detect` block, so an adapter with no
  // search config is simply never scanned (scan mode is opt-in per marketplace,
  // and an unconfigured one degrades to today's behaviour: nothing).
  //
  // A detail page WINS: some marketplaces route a listing under a path that also
  // contains a browse segment, and rendering a grid of card badges over a single
  // listing would replace the real read with the weaker one.
  function isSearchPage(adapter, pathname) {
    if (!adapter || !adapter.search) return false;
    if (isDetailPage(adapter, pathname)) return false;
    return matchesDetect(adapter.search.detect, pathname);
  }

  // US-1880: pick the LARGEST candidate from a `srcset` value. The old content
  // script assumed the last comma-token was largest — but srcset order is not
  // guaranteed, so a "1600w, 320w" set graded the thumbnail. Parse the width (`w`)
  // / density (`x`) descriptors and choose the max: highest width wins; if no
  // widths are present, highest density; ties resolve to the later candidate.
  // Splits on comma-then-whitespace so a CDN URL that itself contains a comma
  // (e.g. Cloudinary transforms) isn't mangled. Returns the URL, or null.
  function srcsetLargest(srcset) {
    if (typeof srcset !== "string" || !srcset.trim()) return null;
    const candidates = srcset.split(/,\s+/).map((s) => s.trim()).filter(Boolean);
    let best = null; // { url, w, x, idx }
    candidates.forEach((cand, idx) => {
      const parts = cand.split(/\s+/);
      const url = parts[0];
      if (!url || !/^https?:\/\//i.test(url)) return;
      let w = 0, x = 0;
      for (let i = 1; i < parts.length; i++) {
        const mw = /^(\d+(?:\.\d+)?)w$/i.exec(parts[i]);
        const mx = /^(\d+(?:\.\d+)?)x$/i.exec(parts[i]);
        if (mw) w = parseFloat(mw[1]);
        else if (mx) x = parseFloat(mx[1]);
      }
      const cur = { url, w, x, idx };
      if (!best) { best = cur; return; }
      if (cur.w !== best.w) { if (cur.w > best.w) best = cur; return; }
      if (cur.x !== best.x) { if (cur.x > best.x) best = cur; return; }
      best = cur; // equal descriptors → prefer the later candidate
    });
    return best ? best.url : null;
  }

  // ── US-1879: remote-config integrity ───────────────────────────────────────
  // The hosted config (marketplace-selectors.json) can be updated without a store
  // resubmission, but it must only ever UPGRADE the bundled adapters — a stale or
  // rolled-back hosted file would otherwise silently downgrade every adapter and
  // could make a newly-bundled marketplace vanish. These helpers gate that.

  // True when a value is a usable config object (a non-empty adapters map). Mirrors
  // the background worker's shape check so both sides agree on "valid".
  function isValidConfig(c) {
    return !!(
      c && typeof c === "object" && c.adapters &&
      typeof c.adapters === "object" && Object.keys(c.adapters).length > 0
    );
  }

  // Semver-ish compare of the dotted version strings ("2026.07.4"). Compares
  // numeric components left-to-right (missing components count as 0); if the
  // numeric cores are equal, a pre-release tag ("2026.07.4-draft") sorts BEFORE
  // the plain release. Returns -1 (a<b), 0 (equal), or 1 (a>b). Non-strings /
  // empty parse as version 0.
  function compareVersions(a, b) {
    const parse = (v) => {
      const s = String(v == null ? "" : v).trim();
      const dash = s.indexOf("-");
      const core = dash === -1 ? s : s.slice(0, dash);
      const pre = dash === -1 ? "" : s.slice(dash + 1);
      const nums = core.split(".").map((x) => {
        const n = parseInt(x, 10);
        return Number.isFinite(n) ? n : 0;
      });
      return { nums, pre };
    };
    const pa = parse(a), pb = parse(b);
    const len = Math.max(pa.nums.length, pb.nums.length);
    for (let i = 0; i < len; i++) {
      const x = pa.nums[i] || 0, y = pb.nums[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    if (pa.pre && !pb.pre) return -1; // pre-release < release
    if (!pa.pre && pb.pre) return 1;
    if (pa.pre !== pb.pre) return pa.pre < pb.pre ? -1 : 1;
    return 0;
  }

  // Decide which config the content script should use. The remote is trusted only
  // when it is structurally valid AND its version is >= the bundled version. Any
  // other case keeps the bundle (a stale/rolled-back/invalid/absent remote can
  // never downgrade the shipped adapters). Returns { config, source, reason } so
  // the caller can log a blocked downgrade.
  function chooseConfig(bundled, remote) {
    if (!isValidConfig(remote)) {
      return { config: bundled, source: "bundled", reason: remote ? "invalid-remote" : "no-remote" };
    }
    // A valid remote but an unreadable bundle → trust the remote.
    if (!isValidConfig(bundled)) {
      return { config: remote, source: "remote", reason: "no-bundled" };
    }
    if (compareVersions(remote.version, bundled.version) >= 0) {
      return { config: remote, source: "remote", reason: "upgrade" };
    }
    return { config: bundled, source: "bundled", reason: "downgrade-blocked" };
  }

  return {
    applyUrlUpgrade,
    pickImageUrl,
    dedupeUrls,
    resolveAdapter,
    matchesDetect,
    isDetailPage,
    isSearchPage,
    srcsetLargest,
    isValidConfig,
    compareVersions,
    chooseConfig,
  };
});
