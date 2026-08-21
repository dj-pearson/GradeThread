// US-2734: the deep checkbox must name the effect that closes a coverage gap.
//
// The flag does TWO things and the label only ever named one.
//
//   1. Candidates are computed for EVERY entry that missed, rather than only
//      for missing REQUIRED ones. This is the effect that turns a report saying
//      "brand: missing" into one saying "brand: missing, and here is what IS on
//      the page". It is the whole reason a report is worth asking for.
//   2. It covers controls that only appear after a menu or dialog is opened.
//
// The old label was "I have already opened the menu or dialog" — effect 2 only.
// A seller checking an ordinary sell form has no reason to tick that, so the
// report came back with brand, tags, price and originalPrice all marked missing
// and no candidate signatures at all. Observed 2026-08-20.
//
// So the label is load-bearing, and nothing guarded it. A relabel back to the
// old wording is a silent regression: the code still works, the reports just
// stop being useful, and the next person spends the round trip finding out.
//
// Zero dependencies, discovered by scripts/test-extensions.mjs.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const POPUP = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
const PROBE = fs.readFileSync(
  path.join(__dirname, "..", "lister", "selector-probe.js"),
  "utf8",
);

// ── 1. The label leads with the outcome, not with the precondition ──────────

{
  // The checkbox and its description, bounded by the label element so the
  // surrounding explanatory comment is not what satisfies this.
  const start = POPUP.indexOf('<label class="pop-probe-deep">');
  assert.ok(start > -1, "the deep checkbox label is gone");
  // Whitespace COLLAPSED first: the label wraps across lines in the HTML, so
  // "every field we could not find" is split by a newline and a matcher written
  // against the rendered sentence finds nothing. The first version of this
  // failed on correct markup for exactly that reason.
  const label = POPUP.slice(start, POPUP.indexOf("</label>", start))
    .replace(/\s+/g, " ");

  assert.ok(
    /every field we could not find/i.test(label),
    "the deep label no longer promises candidates for EVERY missed field. That " +
      "is the effect that closes the coverage gap, and it is the one the old " +
      "label omitted (US-2734).",
  );

  // THE HEADLINE is the text of the span BEFORE the <em>. That is what the
  // seller reads at a glance, and reverting it to the precondition is the exact
  // regression this story fixed.
  //
  // The first version of this check asserted the LABEL started with the old
  // wording. The slice begins at <label ...>, so the anchor could never match
  // and the assertion could never fire - it passed while a sabotage reverted the
  // headline. Caught by sabotaging it.
  const spanOpen = label.indexOf("<span>");
  const emOpen = label.indexOf("<em>");
  assert.ok(spanOpen > -1 && emOpen > spanOpen, "the deep label lost its span/em structure");
  const headline = label.slice(spanOpen + 6, emOpen).trim();

  assert.ok(
    headline.length > 0,
    "the deep label has no headline text before its <em> description",
  );
  assert.ok(
    !/^I have already opened/i.test(headline),
    `the headline reverted to "${headline}" - a seller on an ordinary sell form ` +
      `has no reason to tick that, which is how the empty report happened. Lead ` +
      `with the outcome (US-2734 AC3).`,
  );
  assert.ok(
    /describe|list|show/i.test(headline),
    `the headline "${headline}" does not promise an outcome`,
  );
  assert.ok(
    /menu or dialog/i.test(label),
    "the post-click case should still be mentioned, just not as the whole point",
  );
}

// ── 2. Both effects still exist in the probe ────────────────────────────────

{
  // The label is only honest while the code still does what it claims. This
  // pins effect 1: deep widens the candidate set from missing-REQUIRED to
  // every entry that missed.
  const i = PROBE.indexOf("var wanted = deep");
  assert.ok(i > -1, "the deep gate on the candidate set is gone");
  const gate = PROBE.slice(i, i + 200);
  assert.ok(
    /!e\.found/.test(gate),
    "with deep ON the candidate set no longer covers every entry that missed",
  );
  assert.ok(
    /missingRequired/.test(gate),
    "with deep OFF the candidate set is no longer limited to missing required entries",
  );
}

// ── 3. The report states the flag on every run ──────────────────────────────

{
  // Stated on EVERY flow, not only where it changed the output — otherwise a
  // reader cannot tell "no candidates because nothing missed" from "no
  // candidates because the box was unticked", which is the ambiguity that cost
  // the round trip.
  assert.ok(
    /deep=/.test(PROBE),
    "the report no longer says whether deep was on, so an empty candidate list " +
      "is ambiguous between 'nothing missed' and 'the box was unticked'",
  );
}

// ── 4. AC4: the privacy contract is not widened by any of this ──────────────

{
  // A field's VALUE must never leave the page. selector-probe.test.cjs holds
  // the allowlist in detail; this asserts the story did not quietly relax it.
  assert.ok(
    !/\.value\s*\)/.test(PROBE.slice(PROBE.indexOf("function signature"), PROBE.indexOf("function signature") + 1200)),
    "the candidate signature reads a field value — the probe sends attribute " +
      "names and values from the allowlist plus button label text, never a value",
  );
}

console.log("probe-deep-label.test.cjs: the deep box names the coverage effect, and both effects still exist");
