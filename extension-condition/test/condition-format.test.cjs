// GradeThread Condition Check — unit test for the pure result-formatting
// helpers (US-1884). Zero-dependency node assertion script (the extension ships
// unpacked / to the stores, no CI runner). Run manually:
//   node extension-condition/test/condition-format.test.cjs
// Guards the two field-critical invariants: a NaN/garbage factor score can never
// render, and the factor bars / photo-coverage derive correctly from the data
// the endpoint already returns.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// condition-format.js is a UMD content script (.js so Chrome loads it). The repo
// is type:module, so require() of a .js throws — run its source with an injected
// `self` and read the global it assigns (same pattern as image-utils.test.cjs).
function loadFmt(file) {
  const src = fs.readFileSync(file, "utf8");
  const selfObj = {};
  // eslint-disable-next-line no-new-func
  new Function("self", "module", src)(selfObj, { exports: {} });
  assert.ok(selfObj.GT_CC_FMT, "condition-format.js must set self.GT_CC_FMT (" + file + ")");
  return selfObj.GT_CC_FMT;
}

const FILES = [
  path.resolve(__dirname, "..", "content", "condition-format.js"),
  // Lockstep copy in the unified extension (only tested if present).
  path.resolve(__dirname, "..", "..", "extension-unified", "research", "condition-format.js"),
].filter((f) => fs.existsSync(f));

for (const file of FILES) {
  const FMT = loadFmt(file);
  const tag = path.relative(path.resolve(__dirname, "..", ".."), file);

  // ── safeScore: the NaN / garbage gate (AC5) ────────────────────────────
  assert.strictEqual(FMT.safeScore(7.5), 7.5, tag + ": a valid score passes");
  assert.strictEqual(FMT.safeScore(1), 1, tag + ": min in range");
  assert.strictEqual(FMT.safeScore(10), 10, tag + ": max in range");
  assert.strictEqual(FMT.safeScore(NaN), null, tag + ": NaN → null");
  assert.strictEqual(FMT.safeScore(Infinity), null, tag + ": Infinity → null");
  assert.strictEqual(FMT.safeScore("abc"), null, tag + ": non-numeric string → null");
  assert.strictEqual(FMT.safeScore(undefined), null, tag + ": undefined → null");
  assert.strictEqual(FMT.safeScore(null), null, tag + ": null → null");
  assert.strictEqual(FMT.safeScore(0), null, tag + ": 0 (below 1) → null");
  assert.strictEqual(FMT.safeScore(11), null, tag + ": 11 (above 10) → null");
  assert.strictEqual(FMT.safeScore("8.5"), 8.5, tag + ": numeric string coerces");

  // ── factorBars: ordered, render-ready, NaN-free (AC1 + AC5) ─────────────
  const all = FMT.factorBars({
    fabric_condition: 9,
    structural_integrity: 7,
    cosmetic_appearance: 5,
    functional_elements: 3,
    odor_cleanliness: 10,
  });
  assert.strictEqual(all.length, 5, tag + ": all five factors render");
  assert.deepStrictEqual(
    all.map((r) => r.key),
    ["fabric_condition", "structural_integrity", "cosmetic_appearance", "functional_elements", "odor_cleanliness"],
    tag + ": factors stay in weight order",
  );
  assert.strictEqual(all[0].pct, 90, tag + ": 9/10 → 90%");
  assert.strictEqual(all[0].cls, "gt-cc-s-excellent", tag + ": 9 → excellent");
  assert.strictEqual(all[3].cls, "gt-cc-s-poor", tag + ": 3 → poor");
  assert.ok(all.every((r) => typeof r.label === "string" && r.label.length), tag + ": every row is labeled");

  // A NaN / missing / out-of-range factor is DROPPED, not rendered as NaN.
  const partial = FMT.factorBars({
    fabric_condition: 8,
    structural_integrity: NaN,
    cosmetic_appearance: "oops",
    functional_elements: 15, // out of range
    odor_cleanliness: 6,
  });
  assert.strictEqual(partial.length, 2, tag + ": only the two valid factors survive");
  assert.deepStrictEqual(
    partial.map((r) => r.key),
    ["fabric_condition", "odor_cleanliness"],
    tag + ": the survivors are the valid ones, in order",
  );
  assert.ok(partial.every((r) => Number.isFinite(r.score) && Number.isFinite(r.pct)), tag + ": no NaN leaks into a row");

  assert.deepStrictEqual(FMT.factorBars(null), [], tag + ": null input → []");
  assert.deepStrictEqual(FMT.factorBars(undefined), [], tag + ": undefined input → []");
  assert.deepStrictEqual(FMT.factorBars("nope"), [], tag + ": non-object → []");
  assert.deepStrictEqual(FMT.factorBars({}), [], tag + ": empty object → []");

  // ── photoCountLabel (AC1) ──────────────────────────────────────────────
  assert.strictEqual(FMT.photoCountLabel(1), "Graded from 1 photo", tag + ": singular");
  assert.strictEqual(FMT.photoCountLabel(4), "Graded from 4 photos", tag + ": plural");
  assert.strictEqual(FMT.photoCountLabel(0), null, tag + ": 0 → null");
  assert.strictEqual(FMT.photoCountLabel(NaN), null, tag + ": NaN → null");
  assert.strictEqual(FMT.photoCountLabel(undefined), null, tag + ": undefined → null");
  assert.strictEqual(FMT.photoCountLabel(2.9), "Graded from 2 photos", tag + ": floors fractional");

  // ── lowCoverage (AC1) ──────────────────────────────────────────────────
  assert.strictEqual(FMT.lowCoverage(1), true, tag + ": 1 photo is low coverage");
  assert.strictEqual(FMT.lowCoverage(2), true, tag + ": 2 photos is low coverage");
  assert.strictEqual(FMT.lowCoverage(3), false, tag + ": 3 photos is enough");
  assert.strictEqual(FMT.lowCoverage(4), false, tag + ": 4 photos is enough");
  assert.strictEqual(FMT.lowCoverage(0), false, tag + ": unknown (0) does not nudge");
  assert.strictEqual(FMT.lowCoverage(NaN), false, tag + ": NaN does not nudge");

  console.log("condition-format.test.cjs: all assertions passed (" + tag + ")");
}

if (!FILES.length) {
  throw new Error("condition-format.js not found in either extension");
}
