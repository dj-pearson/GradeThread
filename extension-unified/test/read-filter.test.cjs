// US-3057: the history filter is pure and the popup uses it in memory.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
// Loaded with an injected `self` (the repo is type:module, so require() would
// read a classic script as ESM and hand back nothing).
const selfObj = {};
new Function("self", fs.readFileSync(path.join(dir, "research", "read-filter.js"), "utf8"))(selfObj);
const F = selfObj.GT_READ_FILTER;
assert.ok(F, "research/read-filter.js must assign self.GT_READ_FILTER");

const reads = [
  { title: "Patagonia Better Sweater L", seller: "vintage_finds", marketplace: "ebay" },
  { title: "Levi's 501 Jeans 34x32", seller: "closet_queen", marketplace: "poshmark" },
  { title: "Carhartt Detroit Jacket", seller: "vintage_finds", marketplace: "grailed" },
  { title: "Patagonia Synchilla", seller: null, marketplace: "Poshmark" },
  null,
];

// ── title / seller / marketplace matches ────────────────────────────────────
assert.deepStrictEqual(F.filterReads(reads, {}).length, 4, "no filter keeps every real row and drops junk");
assert.deepStrictEqual(F.filterReads(reads, { q: "patagonia" }).map((r) => r.title), ["Patagonia Better Sweater L", "Patagonia Synchilla"], "title, case-insensitive");
assert.deepStrictEqual(F.filterReads(reads, { q: "VINTAGE_FINDS" }).map((r) => r.title), ["Patagonia Better Sweater L", "Carhartt Detroit Jacket"], "seller, case-insensitive");
assert.deepStrictEqual(F.filterReads(reads, { q: "patagonia vintage" }).map((r) => r.title), ["Patagonia Better Sweater L"], "every word must match, across title and seller");
assert.deepStrictEqual(F.filterReads(reads, { marketplaces: ["poshmark"] }).map((r) => r.title), ["Levi's 501 Jeans 34x32", "Patagonia Synchilla"], "marketplace chip, case-insensitive");
assert.deepStrictEqual(F.filterReads(reads, { marketplaces: ["poshmark", "grailed"] }).length, 3, "several chips union");
assert.deepStrictEqual(F.filterReads(reads, { q: "patagonia", marketplaces: ["poshmark"] }).map((r) => r.title), ["Patagonia Synchilla"], "query AND chips");
assert.deepStrictEqual(F.filterReads(reads, { q: "  " }).length, 4, "whitespace is no query");
assert.deepStrictEqual(F.filterReads(null, { q: "x" }), []);
const before = JSON.stringify(reads);
F.filterReads(reads, { q: "levi" });
assert.strictEqual(JSON.stringify(reads), before, "never mutates the input");

// ── the chips: marketplaces present, most reads first ────────────────────────
assert.deepStrictEqual(F.marketplacesOf(reads), [{ key: "poshmark", count: 2 }, { key: "ebay", count: 1 }, { key: "grailed", count: 1 }]);
assert.deepStrictEqual(F.marketplacesOf([]), []);

// ── the empty copy names the filter ──────────────────────────────────────────
assert.strictEqual(F.emptyCopy({}, 12), null, "nothing filtered: the caller's own empty state");
assert.strictEqual(F.emptyCopy({ q: "hoodie" }, 12), 'None of your 12 reads match "hoodie". Clear the filter to see them all.');
assert.strictEqual(F.emptyCopy({ marketplaces: ["ebay"] }, 1), "None of your 1 read match ebay. Clear the filter to see them all.");
assert.strictEqual(F.emptyCopy({ q: "hoodie", marketplaces: ["ebay", "depop"] }, 3), 'None of your 3 reads match "hoodie" on ebay, depop. Clear the filter to see them all.');

// ── the cap, and the popup's wiring ─────────────────────────────────────────
assert.strictEqual(F.RENDER_CAP, 40);
const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
const js = fs.readFileSync(path.join(dir, "popup.js"), "utf8");
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
assert.ok(/const MAX_RECENT = 100;/.test(bg), "the history holds 100 reads");
for (const id of ["readFilter", "readQuery", "readChips", "readMore"]) {
  assert.ok(html.includes('id="' + id + '"'), "popup.html is missing #" + id);
  assert.ok(js.includes('"' + id + '"'), "popup.js never uses #" + id);
}
assert.ok(html.indexOf('src="research/read-filter.js"') < html.indexOf('src="popup.js"'), "read-filter.js loads before popup.js");
// One storage read for the history; every repaint is in memory.
const readsFn = js.slice(js.indexOf("async function renderReads()"), js.indexOf("function wireReadFilter()"));
assert.strictEqual((readsFn.match(/storage\.local\.get/g) || []).length, 1, "renderReads reads storage once");
const paint = js.slice(js.indexOf("function paintReads()"), js.indexOf("async function renderReads()"));
assert.ok(!/storage\.local/.test(paint), "paintReads never touches storage");
assert.ok(/list\.slice\(0, cap\)/.test(paint), "at most RENDER_CAP rows are painted");
const sellersFn = js.slice(js.indexOf("async function renderSellers()"), js.indexOf("let sellersRendered = false;"));
assert.ok(!/storage\.local/.test(sellersFn) && /currentReads\(\)/.test(sellersFn), "By seller groups the same in-memory, filtered list");
assert.ok(/renderReadStats\(allReads\)/.test(js), "the stats strip reads the WHOLE history, not the filtered view");
const optJs = fs.readFileSync(path.join(dir, "options.js"), "utf8");
assert.ok(/recentReads/.test(optJs) && /remove\("recentReads"\)/.test(optJs), "the options page still counts and clears the whole list");

console.log("read-filter.test.cjs: title/seller/marketplace filters, chips, empty copy, 40-row cap, one storage read, whole-history stats");
