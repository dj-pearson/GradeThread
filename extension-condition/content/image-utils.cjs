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

  // Is `pathname` a detail/item page for this adapter? True when it contains any
  // of detect.pathIncludes, or matches detect.pathRegex.
  function isDetailPage(adapter, pathname) {
    const d = adapter && adapter.detect;
    if (!d || typeof pathname !== "string") return false;
    if (Array.isArray(d.pathIncludes) && d.pathIncludes.some((p) => pathname.includes(p))) return true;
    if (typeof d.pathRegex === "string") {
      try {
        return new RegExp(d.pathRegex).test(pathname);
      } catch (_e) {
        return false;
      }
    }
    return false;
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
    isDetailPage,
    isValidConfig,
    compareVersions,
    chooseConfig,
  };
});
