// US-3210 AC3: the Poshmark picker fill.
//
// The DOM half was verified against the live create-listing page on
// 2026-09-22 (every picker set, read back off its selector). This file pins
// the judgement half, which is where a wrong pick would come from: which
// department, which condition code, which size spelling, which colour tiles,
// and the rule that a picker the seller already set is never clicked.
//
// Zero dependencies, discovered by scripts/test-extensions.mjs.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "lister", "common.js");

function loadGT(document) {
  const src = fs.readFileSync(SRC, "utf8");
  const fn = new Function(
    "self", "document", "KeyboardEvent", "Event", "HTMLInputElement",
    "HTMLTextAreaElement", "setTimeout", "clearTimeout", "console", "globalThis",
    src + "; return self.GTLister;",
  );
  return fn(
    {},
    document || { querySelector: () => null, getElementById: () => null, body: null },
    class {}, class {}, class {}, class {},
    (f) => setTimeout(f, 0),
    clearTimeout,
    { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, info: () => {} },
    { chrome: undefined, browser: undefined },
  );
}

(async () => {
  const GT = loadGT();

  // ── Department: eBay's aspect values onto Poshmark's three ───────────────
  assert.strictEqual(GT.poshmarkDepartment("Women"), "women");
  assert.strictEqual(GT.poshmarkDepartment("Men's"), "men");
  assert.strictEqual(GT.poshmarkDepartment("Boys"), "kids");
  assert.strictEqual(GT.poshmarkDepartment("Unisex Kids"), "kids");
  assert.strictEqual(GT.poshmarkDepartment("Unisex Adult"), null,
    "unisex adult has no Poshmark department, so it must not be guessed");
  assert.strictEqual(GT.poshmarkDepartment(""), null);

  // ── Category path ─────────────────────────────────────────────────────────
  assert.deepStrictEqual(GT.splitCategoryPath("Women > Tops > Blouses"),
    { department: "women", category: "Tops", subcategory: "Blouses" });
  assert.deepStrictEqual(GT.splitCategoryPath("Tops"),
    { department: null, category: "Tops", subcategory: "" });

  // ── Condition codes read off the live form ────────────────────────────────
  assert.strictEqual(GT.poshmarkConditionCode("NWT (New With Tags)"), "nwt");
  assert.strictEqual(GT.poshmarkConditionCode("New With Tags (NWT)"), "nwt");
  assert.strictEqual(GT.poshmarkConditionCode("NWOT (New Without Tags)"), "uln");
  assert.strictEqual(GT.poshmarkConditionCode("Like New"), "uln");
  assert.strictEqual(GT.poshmarkConditionCode("EUC (Excellent Used Condition)"), "ug",
    "EUC is used, and Poshmark's Like New means new without tags");
  assert.strictEqual(GT.poshmarkConditionCode("GUC (Good Used Condition)"), "ug");
  assert.strictEqual(GT.poshmarkConditionCode("Play condition"), "uf");
  assert.strictEqual(GT.poshmarkConditionCode("something else"), null);

  // ── Size spellings ────────────────────────────────────────────────────────
  assert.deepStrictEqual(GT.poshmarkSizeCandidates("Medium"), ["Medium", "M"]);
  assert.ok(GT.poshmarkSizeCandidates("32x34").includes("Waist 32"));
  assert.ok(GT.poshmarkSizeCandidates("2XL").includes("XXL"));
  assert.ok(GT.poshmarkSizeCandidates("15.5").includes("Neck 15.5"));
  assert.deepStrictEqual(GT.poshmarkSizeCandidates(""), []);

  // Sizes match without the contains pass: "S" must not land on "XS".
  const grid = ["XXS", "XS", "S", "M", "L", "XL"];
  assert.strictEqual(grid[GT.matchOption("S", grid, 2)], "S");
  assert.strictEqual(GT.matchOption("XXL", grid, 2), -1, "XXL is on another tab");

  // ── Colours: up to two tiles, each part unambiguous ──────────────────────
  const tiles = ["Red", "Pink", "Orange", "Yellow", "Green", "Blue", "Purple", "Gold",
    "Silver", "Black", "Gray", "White", "Cream", "Brown", "Tan"];
  assert.deepStrictEqual(GT.poshmarkColors("Navy/White", tiles), ["Blue", "White"]);
  assert.deepStrictEqual(GT.poshmarkColors("Heather Grey", tiles), ["Gray"]);
  assert.deepStrictEqual(GT.poshmarkColors("Light Blue", tiles), ["Blue"]);
  assert.strictEqual(GT.poshmarkColors("Red/White/Blue", tiles), null,
    "three colours do not fit Poshmark's two, so none are set");
  assert.strictEqual(GT.poshmarkColors("Black and Gold Blue", tiles), null,
    "a part naming two tiles is ambiguous");
  assert.strictEqual(GT.poshmarkColors("Deep Ocean", tiles), null);

  // ── A picker the seller already set is never clicked (AC7) ───────────────
  {
    let clicks = 0;
    const el = (text) => ({
      innerText: text,
      click: () => { clicks += 1; },
      querySelector: (s) => (s === ".dropdown__selector" ? el(text) : null),
      querySelectorAll: () => [],
      closest: () => el(text),
    });
    const set = el("Women Tops");
    const document = {
      querySelector: () => set,
      getElementById: () => null,
      body: { click: () => {} },
    };
    const G = loadGT(document);
    const res = await G.fillPickers(
      { category: "x", subcategory: "x", condition: "x", sizeButton: "x", colorTile: "x",
        settleMs: 0 },
      { department: "Men", category: "Shirts", size: "M", condition: "EUC", color: "Blue" },
    );
    assert.strictEqual(clicks, 0, "every picker already shows a choice, so nothing is clicked");
    assert.deepStrictEqual(res, { set: [], missed: [] });
  }

  // ── Mercari (mapped on the live sell form 2026-09-22) ────────────────────
  assert.strictEqual(GT.mercariConditionTestId("New"), "ConditionNew");
  assert.strictEqual(GT.mercariConditionTestId("NWT (New With Tags)"), "ConditionNew");
  assert.strictEqual(GT.mercariConditionTestId("Like new"), "ConditionLikeNew");
  assert.strictEqual(GT.mercariConditionTestId("NWOT (New Without Tags)"), "ConditionLikeNew",
    "new WITHOUT tags must not read as New");
  assert.strictEqual(GT.mercariConditionTestId("EUC (Excellent Used Condition)"), "ConditionGood");
  assert.strictEqual(GT.mercariConditionTestId("Poor"), "ConditionPoor");

  // The women's list as the live form renders it: standard, then more systems
  // repeating the same letters. Only the first block may be matched.
  const womens = ["XXS (00)", "XS (0-2)", "S (4-6)", "M (8-10)", "L (12-14)", "XL (16-18)",
    "1X (16-18)", "2XL (20-22)", "3XL (24-26)", "4XL (28-30)", "5XL (32-34)", "One Size",
    "XXS (00)", "XS (0-2)", "S (4-6)", "M (8-10)", "XS (0-1)", "S (3-5)", "M (7-9)"];
  const wBlock = GT.mercariStandardBlock(womens);
  assert.strictEqual(wBlock.length, 12, "the standard block ends at One Size");
  const pick = (size, block) => {
    for (const c of GT.mercariSizeCandidates(size)) {
      const i = GT.matchOption(c, block, 2);
      if (i !== -1) return block[i];
    }
    return null;
  };
  assert.strictEqual(pick("Medium", wBlock), "M (8-10)");
  assert.strictEqual(pick("XXL", wBlock), "2XL (20-22)", "women's XXL is spelled 2XL");
  assert.strictEqual(pick("S", wBlock), "S (4-6)", "S must not land on XS or XXS");
  assert.strictEqual(pick("One Size", wBlock), "One Size");

  // The men's list puts a TALL block after One Size whose "M" would match
  // exactly. Cutting at One Size is what keeps that from winning.
  const mens = ["XS (30-32)", "S (34-36)", "M (38-40)", "L (42-44)", "XL (46-48)",
    "XXL (50-52)", "3XL (54-56)", "4XL (58-60)", "5XL (62-64)", "One Size",
    "M", "L", "XL", "XXL", "XXXL+", "Big 1X", "Big 2X"];
  const mBlock = GT.mercariStandardBlock(mens);
  assert.strictEqual(pick("M", mBlock), "M (38-40)", "standard M, never the tall M");
  assert.strictEqual(pick("2XL", mBlock), "XXL (50-52)", "men's 2XL is spelled XXL");

  console.log("poshmark-pickers.test.cjs: Poshmark and Mercari picker mapping and the never-overwrite rule");
})().catch((e) => { console.error(e); process.exit(1); });
