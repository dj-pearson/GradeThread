// GradeThread unified extension — manifest ⇄ adapter host coverage guard (US-1880).
//
// The RESEARCH content-script `matches` in manifest.json must stay in lockstep
// with the adapter `hosts` + `detect.pathIncludes` in research/selectors.js, or
// the overlay silently never loads on a page. This derives the canonical match
// set from the adapters (one `https://*.<host><path>*` per host × detect path —
// the `*.` form covers apex + www + country subdomains) and asserts the research
// content-script entry equals it exactly. The Lister content-script entries are a
// separate, intentionally-broad match set (not adapter-derived) and are ignored
// here. Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadBundledConfig() {
  const src = fs.readFileSync(path.join(dir, "research", "selectors.js"), "utf8");
  const selfObj = {};
  // eslint-disable-next-line no-new-func
  new Function("self", src)(selfObj);
  return selfObj.GT_CC_CONFIG;
}

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

// The research entry is the one that injects research/marketplace.js.
const cs = (manifest.content_scripts || []).find(
  (c) => Array.isArray(c.js) && c.js.includes("research/marketplace.js"),
);
assert.ok(cs, "manifest must have the research content_scripts entry (research/marketplace.js)");

const actual = cs.matches || [];
const expected = expectedMatches(cfg);

const actualSet = new Set(actual);
const expectedSet = new Set(expected);

const missing = expected.filter((m) => !actualSet.has(m));
const orphan = actual.filter((m) => !expectedSet.has(m));

assert.deepStrictEqual(
  missing,
  [],
  `manifest.json is MISSING research content-script matches for these adapter hosts: ${missing.join(", ")}`,
);
assert.deepStrictEqual(
  orphan,
  [],
  `manifest.json has ORPHAN research content-script matches with no matching adapter host: ${orphan.join(", ")}`,
);
assert.equal(actual.length, expectedSet.size, "manifest research matches contains duplicates");

console.log(
  `manifest-hosts.test.cjs (unified): ${actual.length} research content-script matches cover every adapter host (no drift)`,
);
