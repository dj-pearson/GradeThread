// GradeThread unified extension — manifest ⇄ adapter host coverage guard
// (US-1880, contract updated by US-1878).
//
// The RESEARCH content-script `matches` in manifest.json must stay in lockstep
// with the adapter `hosts` in research/selectors.js, or the overlay silently never
// loads on a page.
//
// US-1878 CHANGED WHAT "IN LOCKSTEP" MEANS. This used to derive one match per
// host × detect.pathIncludes (`https://*.poshmark.com/listing/*`), pinning the
// manifest to DETAIL-PAGE URLs only. That is precisely the bug US-1878 fixed: five
// of six marketplaces are SPA-first, so clicking a listing from the feed is a
// client-side navigation with no page load — and a detail-only match means the
// content script was never injected in the first place, so there was nothing there
// to notice the navigation. The extension effectively only worked on eBay.
//
// The manifest now matches WHOLE DOMAINS (`https://*.poshmark.com/*`) and the
// runtime gate moved into boot(): resolveAdapter + isDetailPage() keep every
// non-listing page a no-op. So this asserts host-level coverage, and the
// detail-page filtering is covered by the adapter detect tests instead.
//
// The `*.` form covers apex + www + country subdomains. The Lister content-script
// entries are a separate, intentionally-broad match set (not adapter-derived) and
// are ignored here. Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadBundledConfig() {
  const src = fs.readFileSync(path.join(dir, "research", "selectors.js"), "utf8");
  const selfObj = {};
   
  new Function("self", src)(selfObj);
  return selfObj.GT_CC_CONFIG;
}

function expectedMatches(cfg) {
  const out = [];
  for (const key of Object.keys(cfg.adapters)) {
    const a = cfg.adapters[key];
    for (const host of a.hosts || []) out.push(`https://*.${host}/*`);
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

// US-1878: a detail-page-scoped match would reintroduce the SPA bug — the script
// would never be injected on the feed, so it could never see the navigation into a
// listing. Pin that explicitly rather than relying on the equality above to be read
// correctly by whoever edits this next.
for (const m of actual) {
  assert.ok(
    /^https:\/\/\*\.[^/]+\/\*$/.test(m),
    `research match "${m}" is path-scoped. It must match the WHOLE domain (https://*.<host>/*): ` +
      "on an SPA marketplace the shopper arrives at a listing by client-side navigation, so a " +
      "detail-only match means the content script is never injected and the pill never appears " +
      "(US-1878). Non-listing pages are gated at runtime by isDetailPage(), not by the manifest.",
  );
}

console.log(
  `manifest-hosts.test.cjs (unified): ${actual.length} research content-script matches cover every adapter host, whole-domain (no drift)`,
);
