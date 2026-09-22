// GradeThread unified extension — Depop lister guard (US-3462).
//
// Depop's form has no title field, so depop.js leads the description with the
// title. This pins that helper and the live-listing pattern, the two parts of
// the Depop channel that are ours rather than the shared runner's.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadGlobal(rel, name) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  return new Function("self", "globalThis", `${src}; return self.${name};`)(scope, {});
}

const SEL = loadGlobal("lister/selectors.js", "GT_LISTER_SELECTORS");
// depop.js returns early without GT/chrome, after exposing the helper.
const { depopDescription } = loadGlobal("lister/depop.js", "GTDepop");
const cfg = SEL.depop;

// ── 1. The title leads the description ─────────────────────────────────────
assert.strictEqual(
  depopDescription("Levi's 501 jeans", "Great fade, no holes."),
  "Levi's 501 jeans\n\nGreat fade, no holes.",
  "title first, blank line, then the copy",
);
assert.strictEqual(
  depopDescription("Levi's 501 jeans", "levi's 501 jeans, great fade."),
  "levi's 501 jeans, great fade.",
  "copy that already opens with the title is not doubled",
);
assert.strictEqual(depopDescription("", "Just copy"), "Just copy", "no title keeps the copy");
assert.strictEqual(depopDescription("Only a title", ""), "Only a title", "no copy keeps the title");
assert.strictEqual(depopDescription(null, undefined), "", "nothing gives an empty string");

// ── 2. Cut to Depop's 1000 characters on a word boundary ───────────────────
{
  const long = depopDescription("Title", "word ".repeat(400));
  assert.ok(long.length <= 1000, `description is at most 1000 chars (got ${long.length})`);
  assert.ok(/word$/.test(long), "the cut lands after a whole word, not inside one");
  const unbroken = depopDescription("", "x".repeat(1500));
  assert.strictEqual(unbroken.length, 1000, "a single unbroken run is hard-cut at 1000");
}

// ── 3. The live-listing pattern never matches the form we opened ───────────
{
  const re = new RegExp(cfg.liveListingUrlPattern);
  assert.ok(re.test("https://www.depop.com/products/someseller-levis-501-jeans-1a2b/"), "a listing matches");
  assert.ok(!re.test("https://www.depop.com/products/create/"), "the create form does not");
  assert.ok(!re.test("https://www.depop.com/products/create/first/"), "the first-listing form does not");
  assert.ok(!re.test("https://www.depop.com/products/edit/someseller-levis-501-jeans-1a2b/"), "the editor does not");
  assert.ok(!re.test("https://www.depop.com/someseller/"), "a shop page does not");
}

// ── 4. Shape: what was checked on the live form, and what was not ──────────
assert.strictEqual(cfg.enabled, true, "the list flow is on");
assert.strictEqual(cfg.lastVerified, "2026-09-22", "list verified on the live form");
assert.ok(!cfg.fields.title, "Depop has no title field, so none is declared");
assert.deepStrictEqual(cfg.required, ["description", "price", "submit"], "pre-interaction selectors only");
assert.strictEqual(cfg.delist.enabled, false, "delist stays off until checked on an owned listing");
assert.strictEqual(cfg.delist.lastVerified, null, "an unchecked delist carries no date");
assert.strictEqual(cfg.revise.titleless, true, "revise knows there is no title field");

console.log("depop-lister.test.cjs: title leads the description without doubling, 1000-char word-boundary cut, live-listing pattern excludes create/first/edit, list on + delist/revise off and undated");
