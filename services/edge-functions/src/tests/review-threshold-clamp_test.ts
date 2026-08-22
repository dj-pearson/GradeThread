// US-2789 / US-884 / US-331: the review threshold cannot be set to a value that
// disables human review.
//
// `reviewConfidenceThreshold()` decides whether a grade goes to a person.
// src/test/confidence-threshold-sites.test.ts holds a genuinely good property
// about it — that no site compares a confidence against a 0.75 LITERAL — and
// that is a corpus negative a unit test can never express, so that guard stays
// exactly as it is.
//
// What nothing checked is the function itself. It was called by no test at all,
// and the part worth checking is the CLAMP its own comment names: "Clamped to
// (0, 1] so a bad stored value can never disable review."
//
// WHY THAT MATTERS MORE THAN THE NUMBER. The threshold is tunable from the
// admin UI without a deploy (US-884) — that is the whole point of moving it into
// the settings registry. A tunable safety gate is one somebody can turn off by
// accident: `0` would send nothing to review, and a value above 1 would send
// EVERYTHING, which is the same outage wearing the opposite mask. The clamp is
// what makes the tunability safe, and it had no test.
//
//   deno test --allow-env src/tests/review-threshold-clamp_test.ts
import "./_env.ts";
import { assertEquals } from "@std/assert";

const KEY = "GRADING_REVIEW_CONFIDENCE_THRESHOLD";
const { reviewConfidenceThreshold } = await import("../lib/ai-config.ts");

/**
 * Run with one env value and restore whatever was there.
 *
 * The settings cache is empty in a unit test, so `getSettingSync` returns its
 * fallback and the env path IS the path under test. That is stated rather than
 * relied on silently — see the note at the bottom about the half this cannot
 * reach.
 */
function withEnv(value: string | null, fn: () => void) {
  const prior = Deno.env.get(KEY);
  try {
    if (value === null) Deno.env.delete(KEY);
    else Deno.env.set(KEY, value);
    fn();
  } finally {
    if (prior === undefined) Deno.env.delete(KEY);
    else Deno.env.set(KEY, prior);
  }
}

Deno.test("US-884: a valid threshold is honoured", () => {
  // The reason the setting exists: the calibration report's recommended
  // operating point gets applied without a deploy.
  for (const v of ["0.6", "0.75", "0.9", "1"]) {
    withEnv(v, () => assertEquals(reviewConfidenceThreshold(), Number(v)));
  }
});

Deno.test("US-331: ZERO cannot disable review", () => {
  // The failure this clamp exists for. A threshold of 0 means no grade is ever
  // below it, so nothing is ever routed to a human — and nothing errors, so the
  // queue simply goes quiet and looks like a good week.
  withEnv("0", () => assertEquals(reviewConfidenceThreshold(), 0.75));
  withEnv("-0.5", () => assertEquals(reviewConfidenceThreshold(), 0.75));
});

Deno.test("US-331: above 1 cannot send EVERYTHING to review", () => {
  // The same outage wearing the opposite mask: confidence is a 0-1 score, so a
  // threshold above 1 flags every grade and the queue becomes unusable. Both
  // ends are refused, not just the dangerous-looking one.
  for (const v of ["1.5", "75", "100"]) {
    withEnv(v, () => assertEquals(reviewConfidenceThreshold(), 0.75));
  }
});

Deno.test("US-331: unparseable and empty values fall back rather than becoming NaN", () => {
  // Number("") is 0, Number("abc") is NaN and Number("Infinity") is Infinity.
  // None of them is a threshold, and each reaches the fallback by a different
  // route: 0 fails `> 0`, NaN fails every comparison, Infinity fails `<= 1`.
  // What matters is that all three land on 0.75 rather than on themselves —
  // a stored 0 would route nothing to review and a stored NaN would make the
  // comparison false everywhere, which disables it just as completely and
  // without an error either way.
  for (const v of ["", "  ", "abc", "0.75.1", "Infinity", "NaN"]) {
    withEnv(v, () => assertEquals(reviewConfidenceThreshold(), 0.75, `value ${JSON.stringify(v)}`));
  }
});

Deno.test("US-331: an unset variable is the documented default", () => {
  withEnv(null, () => assertEquals(reviewConfidenceThreshold(), 0.75));
});

Deno.test("the default matches the documented review threshold", () => {
  // 0.75 is the flat threshold in the grading contract
  // (vault/20-domain, and the grading-engine skill). A drift here would move the
  // gate for every deployment that has not set the variable — which is all of
  // them by default.
  withEnv(null, () => assertEquals(reviewConfidenceThreshold(), 0.75));
});

// ── WHAT THIS DOES NOT REACH, said plainly ────────────────────────────────
//
// There are TWO clamps in reviewConfidenceThreshold: one on the env fallback and
// one on the value that comes back from the settings registry. Only the first is
// exercised here, because `getSettingSync` returns its fallback on a cold cache
// and there is no exported way to seed the cache with a poisoned value.
//
// The stored-value clamp is the one an ADMIN can actually trip, so it is the
// more valuable of the two and it remains untested. Reaching it needs either an
// exported cache seam or an integration test against a real settings row —
// neither is a change this file should make on its own.

// ── One sabotage came back "blind", and the sabotage was wrong ─────────────
//
// Mutating the clamp five ways reddens four of them: removing it entirely,
// letting zero through, dropping the upper bound, and drifting the default off
// 0.75. Removing `Number.isFinite` stays GREEN, and that is correct rather than
// a hole.
//
// The two comparisons that follow it already exclude every non-finite value:
// NaN fails any comparison, +Infinity fails `<= 1`, and -Infinity fails `> 0`.
// So `Number.isFinite(raw) && raw > 0 && raw <= 1` and `raw > 0 && raw <= 1`
// agree on every input, and no test can catch the difference because there is
// no difference to catch.
//
// The check stays in the source. It costs nothing, it documents the intent at
// the point of use, and removing defensive code from the human-review gate to
// satisfy a coverage argument is the wrong trade. What is recorded here is that
// a future sabotage run will report it as blind again — and should not be
// answered by contorting a test to match a redundant branch.
