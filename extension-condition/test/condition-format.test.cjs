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

  // ── fmt + centralized copy (AC5) ───────────────────────────────────────
  assert.strictEqual(FMT.fmt("plain", null), "plain", tag + ": no vars → unchanged");
  assert.strictEqual(FMT.fmt("hi {who}", { who: "you" }), "hi you", tag + ": substitutes");
  assert.strictEqual(FMT.fmt("{a} and {b}", { a: 1, b: 2 }), "1 and 2", tag + ": multiple");
  // An unknown placeholder stays VISIBLE. A blank would be a mystery in the UI;
  // a literal "{when}" is a bug report someone can act on.
  assert.strictEqual(FMT.fmt("at {when}", { other: 1 }), "at {when}", tag + ": unknown key kept");
  assert.strictEqual(FMT.fmt(undefined, {}), "", tag + ": a missing template renders nothing");
  // Object.prototype keys must not resolve — `{toString}` is not a variable.
  assert.strictEqual(FMT.fmt("{toString}", {}), "{toString}", tag + ": prototype keys are not vars");

  // Every string is a non-empty string, and every placeholder it declares is a
  // plain name `fmt` can substitute. A typo'd `{ n }` renders raw to a shopper.
  for (const key of Object.keys(FMT.STRINGS)) {
    const value = FMT.STRINGS[key];
    assert.strictEqual(typeof value, "string", tag + ": STRINGS." + key + " must be a string");
    assert.ok(value.length > 0, tag + ": STRINGS." + key + " must not be empty");
    const braces = value.match(/\{[^}]*\}/g) || [];
    for (const b of braces) {
      assert.ok(
        /^\{\w+\}$/.test(b),
        tag + ": STRINGS." + key + ' has an unsubstitutable placeholder "' + b + '"',
      );
    }
  }

  // ── timeAgo (AC5: its copy is in STRINGS too) ──────────────────────────
  const NOW = 1_700_000_000_000;
  assert.strictEqual(FMT.timeAgo(NOW - 5_000, NOW), "just now", tag + ": seconds");
  assert.strictEqual(FMT.timeAgo(NOW - 5 * 60_000, NOW), "5m ago", tag + ": minutes");
  assert.strictEqual(FMT.timeAgo(NOW - 3 * 3_600_000, NOW), "3h ago", tag + ": hours");
  assert.strictEqual(FMT.timeAgo(NOW - 2 * 86_400_000, NOW), "2d ago", tag + ": days");
  assert.strictEqual(FMT.timeAgo(NOW + 60_000, NOW), "just now", tag + ": a future stamp never goes negative");
  assert.strictEqual(FMT.timeAgo("nonsense", NOW), "just now", tag + ": garbage degrades, never NaN");

  console.log("condition-format.test.cjs: all assertions passed (" + tag + ")");
}

// ── The overlays actually READ the table (AC5) ─────────────────────────────
//
// Everything above tests the table. This tests that the copy MOVED: a STRINGS
// entry beside a live literal is worse than no table at all, because the next
// author translates the table and ships a half-English overlay. Asserting the
// retired literal cannot come back is the half that a "the new string is
// present" check would pass right beside a reverted paragraph.
//
// COMMENTS ARE STRIPPED FIRST. Several of these phrases are quoted in the
// explanatory comments around the code that used to render them ("Re-read" below
// forces a new one) — scanning raw source fails on prose, which is the fastest
// way to get a guard deleted for crying wolf.
function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null; // the delimiter we're inside, or null
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += c + (next || "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const RETIRED_LITERALS = [
  '"Get condition read"',
  '"Reading the listing photos\u2026"',
  '"Copy photo request"',
  '"Re-read"',
  '"Try again"',
  '"Close GradeThread condition check"',
  '"Low confidence from listing photos',
  '"Couldn\'t grade this listing right now."',
  '"Watch on GradeThread"',
];

const OVERLAYS = [
  path.resolve(__dirname, "..", "content", "marketplace.js"),
  path.resolve(__dirname, "..", "..", "extension-unified", "research", "marketplace.js"),
].filter((f) => fs.existsSync(f));

assert.ok(OVERLAYS.length, "no marketplace.js found to check");
for (const file of OVERLAYS) {
  const src = stripComments(fs.readFileSync(file, "utf8"));
  const tag = path.relative(path.resolve(__dirname, "..", ".."), file);
  assert.ok(
    src.includes("FMT.STRINGS"),
    tag + ": the overlay must read its copy from FMT.STRINGS",
  );
  for (const literal of RETIRED_LITERALS) {
    assert.ok(
      !src.includes(literal),
      tag + ": user-facing literal " + literal + " is back in the content script — it belongs " +
        "in condition-format.js STRINGS, which is the only table a _locales pass will read",
    );
  }
  // timeAgo moved into the pure module; a local copy would drift from its copy.
  assert.ok(
    !/function timeAgo\(/.test(src),
    tag + ": timeAgo is FMT.timeAgo now — a local copy carries its own untranslated strings",
  );
}

if (!FILES.length) {
  throw new Error("condition-format.js not found in either extension");
}
