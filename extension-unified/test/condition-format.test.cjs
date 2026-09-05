// research/condition-format.js — the overlay's copy and its safe formatters.
//
// This file did not exist before US-3066. condition-format.js has been the home
// of the overlay's user-facing strings since US-1884, with two invariants
// written in its header (no NaN can reach the DOM; copy is centralised for a
// future i18n pass) and nothing asserting either. Adding the quick-look strings
// was the moment that stopped being acceptable, because those three are the ones
// where the wording IS the safety property.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// A UMD content script, kept `.js` because Chrome rejects a `.cjs` content
// script. The repo is type:module, so require() of a .js returns an empty
// object rather than throwing — the quiet version of this mistake. Load it the
// way Chrome does: run the source with an injected `self`.
function load(rel, global) {
  const src = fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
  const selfObj = {};
  new Function("self", src)(selfObj);
  assert.ok(selfObj[global], `${rel} must assign self.${global}`);
  return selfObj[global];
}

const FMT = load("research/condition-format.js", "GT_CC_FMT");

// ── the existing invariants, finally asserted ───────────────────────────────

// US-1884 AC5 invariant 1: a non-finite or out-of-range factor score can never
// reach the DOM. The header has claimed this for a year with nothing checking.
(function safeScoreDropsNonsense() {
  assert.ok(typeof FMT.safeScore === "function", "safeScore must be exported");
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, "7", {}, -1, 11]) {
    const out = FMT.safeScore(bad);
    assert.ok(
      out === null || (typeof out === "number" && Number.isFinite(out)),
      `safeScore(${String(bad)}) returned ${String(out)} — the overlay would ` +
        `render that`,
    );
  }
  // A real score survives untouched.
  assert.strictEqual(FMT.safeScore(8.5), 8.5);
})();

// ── US-3066: the on-device quick look never reads as a grade ────────────────
//
// The quick look is a free, on-device first impression. It must not look like
// the certified read, because a shopper cannot see the difference between a
// number this produced and a number the grading pipeline produced — and only
// one of those has a prompt version, an eval gate, a review threshold and a
// certificate behind it.
//
// Two halves, and both matter: it must not SAY grade or show a number, and it
// must say plainly what it is not. A quick look with neither is just an
// unlabelled second opinion.
(function quickLookNeverReadsAsAGrade() {
  const S = FMT.STRINGS;
  const label = S.quickLookLabel;
  const note = S.quickLookNote;
  const empty = S.quickLookEmpty;

  assert.ok(label && note && empty, "the three quick-look strings must exist");

  const all = [label, note, empty].join(" ");
  assert.ok(
    !/\d+\.\d/.test(all),
    `quick-look copy contains a decimal number, which reads as a grade: ${all}`,
  );
  assert.ok(
    !/\b\d+\s*\/\s*10\b/.test(all),
    "quick-look copy must not contain an out-of-ten score either",
  );

  // The word "grade" is allowed ONLY in the sentence denying it. Strip that
  // clause and nothing should be left.
  const withoutDenial = all.replace(/is not a condition grade/i, "");
  assert.ok(
    !/\bgrades?\b/i.test(withoutDenial),
    "quick-look copy may say what it is NOT and must not otherwise use the " +
      "word grade",
  );
  assert.ok(
    /not a condition grade/i.test(note),
    "the note must say plainly that this is not a condition grade",
  );

  // Where it ran is the other half of the promise: nothing was sent anywhere.
  assert.ok(/on your device/i.test(label), "the label must say where it ran");
  assert.ok(
    /nothing was sent/i.test(note),
    "the note must say nothing left the machine — that is the point of it",
  );

  // No tier name may appear either. A tier is a grade with a word instead of a
  // number and would be read exactly the same way.
  for (const tier of ["NWT", "NWOT", "Excellent", "Very Good", "Fair", "Poor"]) {
    assert.ok(
      !new RegExp("\\b" + tier + "\\b").test(all),
      `quick-look copy names the tier "${tier}", which reads as a grade`,
    );
  }
})();

// ── the copy lives HERE, and only here ──────────────────────────────────────
(function copyIsNotDuplicatedInTheModelModule() {
  // research/local-model.js runs the model; how a shopper reads the result is a
  // copy decision. Two copies of a string whose whole job is to not say "grade"
  // is two places to get that wrong, and only one of them gets reviewed.
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "research", "local-model.js"),
    "utf8",
  );
  const code = src
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert.ok(
    !/Quick look \(on your device\)/.test(code),
    "local-model.js carries the quick-look label. It belongs in " +
      "condition-format.js with the rest of the overlay's copy.",
  );
})();

console.log(
  "✓ condition-format: safeScore drops nonsense, and the quick look never " +
    "reads as a grade",
);
