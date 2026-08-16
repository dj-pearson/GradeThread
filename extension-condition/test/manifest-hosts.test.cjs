// GradeThread Condition Check — manifest ⇄ adapter host coverage guard (US-1880).
//
// The content-script `matches` in manifest.json must stay in lockstep with the
// adapter `hosts` + `detect.pathIncludes` in selectors.js. Before this guard they
// drifted: adapters accepted apex domains but the manifest matched www-only, eBay
// covered 5 TLDs while the intl footprint needed ~14, and *.poshmark.ca was
// unmatched — so the overlay silently never loaded on those pages. This derives
// the canonical match set from the adapters (one `https://*.<host><path>*` per
// host × detect path — the `*.` form covers apex + www + country subdomains) and
// asserts the manifest equals it exactly, so a new adapter host can't ship without
// its injection match (and vice-versa). Same pattern as config-sync.test.cjs.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadBundledConfig() {
  const src = fs.readFileSync(path.join(dir, "selectors.js"), "utf8");
  const selfObj = {};
   
  new Function("self", src)(selfObj);
  return selfObj.GT_CC_CONFIG;
}

// Canonical injection match for an adapter host + detect path. `*.<host>` covers
// the apex and every subdomain (Chrome/MDN match-pattern semantics), collapsing
// the www-vs-apex drift into one entry.
function expectedMatches(cfg) {
  const out = [];
  for (const key of Object.keys(cfg.adapters)) {
    const a = cfg.adapters[key];
    const paths = (a.detect && a.detect.pathIncludes) || [];
    for (const host of a.hosts || []) {
      for (const p of paths) out.push(`https://*.${host}${p}*`);
    }
  }
  return out;
}

const cfg = loadBundledConfig();
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

const cs = (manifest.content_scripts || []).find(
  (c) => Array.isArray(c.js) && c.js.includes("content/marketplace.js"),
);
assert.ok(cs, "manifest must have the marketplace content_scripts entry");

const actual = cs.matches || [];
const expected = expectedMatches(cfg);

// Set equality both ways — a missing match means an adapter host that never
// injects; an orphan match means a match for a host no adapter serves.
const actualSet = new Set(actual);
const expectedSet = new Set(expected);

const missing = expected.filter((m) => !actualSet.has(m));
const orphan = actual.filter((m) => !expectedSet.has(m));

assert.deepStrictEqual(
  missing,
  [],
  `manifest.json is MISSING content-script matches for these adapter hosts (add them or regenerate): ${missing.join(", ")}`,
);
assert.deepStrictEqual(
  orphan,
  [],
  `manifest.json has ORPHAN content-script matches with no matching adapter host (remove them): ${orphan.join(", ")}`,
);
// Guard against accidental duplicates in the manifest.
assert.equal(actual.length, expectedSet.size, "manifest matches contains duplicates");

console.log(
  `manifest-hosts.test.cjs: ${actual.length} content-script matches cover every adapter host (no drift)`,
);
