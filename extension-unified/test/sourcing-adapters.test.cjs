// extension-unified/research/selectors.js — the SOURCING adapters (US-3067).
//
// A sourcing site is where a reseller BUYS. Every other adapter in this config
// is a place a shopper buys from a reseller, and the difference is not cosmetic:
// on a resale listing there is a seller making a condition claim that the
// overlay checks, and on ShopGoodwill there is a charity's photograph of a
// donation and the only question is whether to bid. So the sourcing adapters
// are held to three rules the others are not, and all three are asserted here.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

function loadConfig() {
  const src = fs.readFileSync(
    path.join(root, "extension-unified", "research", "selectors.js"),
    "utf8",
  );
  const selfObj = {};
  new Function("self", src)(selfObj);
  assert.ok(selfObj.GT_CC_CONFIG, "selectors.js must assign self.GT_CC_CONFIG");
  return selfObj.GT_CC_CONFIG;
}

const cfg = loadConfig();
const SOURCING = Object.entries(cfg.adapters).filter(([, a]) => a.sourcing === true);

assert.ok(SOURCING.length > 0, "no sourcing adapter is registered");

// ── 1. the id comes off the URL, and only the id ───────────────────────────

(function idExtraction() {
  const sg = cfg.adapters.shopgoodwill;
  assert.ok(sg, "the shopgoodwill adapter is gone");
  const re = new RegExp(sg.assetIdPattern);

  for (const [url, want] of [
    ["https://shopgoodwill.com/item/276277887", "276277887"],
    ["https://shopgoodwill.com/item/276278053?utm=x", "276278053"],
    ["https://www.shopgoodwill.com/item/1", "1"],
  ]) {
    const m = url.match(re);
    assert.ok(m, `no id found in ${url}`);
    assert.strictEqual(m[1], want, url);
  }

  // Digits only. A search grid, a category page and a seller page are not lots,
  // and matching one would attach a verdict to a page with no single item on it.
  for (const url of [
    "https://shopgoodwill.com/categories/listing?st=jacket",
    "https://shopgoodwill.com/item/",
    "https://shopgoodwill.com/item/abc",
    "https://shopgoodwill.com/",
  ]) {
    assert.strictEqual(url.match(re), null, `${url} was read as a lot`);
  }
})();

// ── 2. no search block, ever ────────────────────────────────────────────────

(function noScanOnASourcingSite() {
  // The scan is the anonymous condition read applied to a results grid. On a
  // sourcing site it would put grades on a charity's donation photos, for a
  // seller who made no claim to check. scan-format.test.cjs enforces the same
  // rule from the other side; this is the one that reads as its own sentence.
  for (const [key, a] of SOURCING) {
    assert.ok(!a.search, `sourcing adapter ${key} carries a search block`);
    assert.ok(
      !a.condition,
      `sourcing adapter ${key} carries condition selectors — there is no seller claim to read`,
    );
  }
})();

// ── 3. a content-script match, and NO host permission ──────────────────────

(function readOnlyMeansNoHostPermission() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "extension-unified", "manifest.json"), "utf8"),
  );
  const research = manifest.content_scripts.find(
    (c) => Array.isArray(c.js) && c.js.includes("research/marketplace.js"),
  );
  assert.ok(research, "the research content-script block is gone");

  for (const [key, a] of SOURCING) {
    for (const host of a.hosts) {
      assert.ok(
        research.matches.includes(`https://*.${host}/*`),
        `${key}: ${host} has no content-script match, so the adapter never runs`,
      );
      // ⚠ THE INTERESTING HALF. host_permissions is the list of sites the
      // extension ACTS on — the lister writes into poshmark, mercari, grailed,
      // vinted and facebook forms. A read-only surface needs a `matches` entry
      // and nothing more, and eBay and Depop have run that way for months. A
      // sourcing site is read-only by definition (it never bids), so a host
      // permission here would ask every user for write access to a site we
      // never write to — and US-3067's AC1 asks for exactly that.
      assert.ok(
        !manifest.host_permissions.some((h) => h.includes(host)),
        `${key}: ${host} is in host_permissions, but a sourcing site is never written to`,
      );
    }
  }
})();

// ── 4. the gallery can actually produce a URL ──────────────────────────────

(function theStyleAttributeIsRead() {
  // ShopGoodwill's ngx-gallery paints each photo as an inline background-image.
  // With imageAttrs: ["src"] the selectors MATCH and yield zero urls, which is
  // indistinguishable from a dead selector in the health telemetry.
  const sg = cfg.adapters.shopgoodwill;
  assert.ok(
    sg.imageAttrs.includes("style"),
    "shopgoodwill.imageAttrs must read `style` or the gallery silently returns nothing",
  );

  const src = fs.readFileSync(
    path.join(root, "extension-unified", "research", "marketplace.js"),
    "utf8",
  );
  assert.ok(
    /attr === "style"/.test(src),
    "marketplace.js does not special-case the style attribute",
  );

  // And the extraction itself, against the shape the live page serves.
  const m = 'background-image: url("https://shopgoodwillimages.azureedge.net/production/32/Items/2026-07-16/abc_07161.png");'
    .match(/url\(\s*["']?([^"')]+)/i);
  assert.ok(m);
  assert.ok(m[1].endsWith("_07161.png"), m[1]);
})();

// ── 5. the health allowlist knows about it ─────────────────────────────────

(function selectorHealthAcceptsIt() {
  // A new adapter left out of SELECTOR_HEALTH_ADAPTERS has every ping
  // discarded, so the least-verified marketplace is the one reporting nothing.
  const src = fs.readFileSync(
    path.join(root, "services", "edge-functions", "src", "routes", "public-grading.ts"),
    "utf8",
  );
  const block = /const SELECTOR_HEALTH_ADAPTERS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(block, "SELECTOR_HEALTH_ADAPTERS is gone");
  for (const [key] of SOURCING) {
    assert.ok(
      block[1].includes(`"${key}"`),
      `${key} ships in the extension but selector health rejects it`,
    );
  }
})();

// ── 6. goodwillfinds is not here, and this says why ────────────────────────

(function theDeadHostStaysOut() {
  // US-3067 names goodwillfinds.com as the second sourcing host. It shut down
  // on 2025-03-28 and the domain does not resolve — measured 2026-09-05,
  // SERVFAIL on Google public DNS for both the apex and www, with
  // shopgoodwill.com resolving from the same command as a control.
  //
  // This assertion is here so that adding it back is a deliberate act with a
  // failing test attached, rather than someone reading the criterion and
  // spending a day writing selectors for a site that is not there.
  const raw = fs.readFileSync(
    path.join(root, "extension-unified", "research", "selectors.js"),
    "utf8",
  );
  for (const [key, a] of Object.entries(cfg.adapters)) {
    assert.ok(
      !a.hosts.some((h) => h.includes("goodwillfinds")),
      `${key} declares goodwillfinds.com, which no longer resolves`,
    );
  }
  assert.ok(
    /goodwillfinds/i.test(raw),
    "the note explaining why goodwillfinds is absent has been deleted",
  );
})();

console.log(
  `sourcing-adapters.test.cjs: ${SOURCING.length} sourcing adapter(s) — id off the URL only, ` +
    "no scan, no condition read, a content-script match with no host permission, " +
    "a gallery that reads background-image, and goodwillfinds stays out",
);
