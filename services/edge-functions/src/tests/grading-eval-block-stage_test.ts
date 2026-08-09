// US-2438 AC2: the eval gate must not report a pass for a change it did not run.
//
// THE DEFECT THIS PINS. compositeGrade() has always carried a comment saying a
// block override is "deliberately NOT accepted here yet". The decision was
// right. It was also only ever written down — runEval read `blockRow.stage`,
// accepted a COMPOSITE block candidate, built the override from it, and then
// passed that override to analyzeImage ONLY. analyzeImage builds the PER-IMAGE
// prompt, which contains no composite block, so the override reached nothing.
//
// The run therefore graded the champion end to end and wrote the result into
// grading_eval_runs under the candidate's own `block:...` label. That is not a
// missing feature, it is a FALSE PASS, and it is the most expensive shape one
// can take: a gate whose entire job is to say "this change was measured and it
// qualified" saying exactly that about a change that never ran.
//
// A SOURCE GUARD rather than a behavioural one, deliberately. Driving runEval
// far enough to reach the composite call needs a database, a golden set and
// real vision calls — the three things this gate exists to spend money on. The
// property is structural and cheap to state: the refusal exists, and it is
// keyed on the stage. When compositeGrade learns to take the override, this
// file is the thing that fails and tells the next person what else to change.

import { assert } from "@std/assert";

const EVAL = await Deno.readTextFile(
  new URL("../lib/grading-eval.ts", import.meta.url),
);
const AI = await Deno.readTextFile(
  new URL("../lib/ai-grading.ts", import.meta.url),
);

Deno.test("US-2438: runEval REFUSES a composite block candidate", () => {
  // Anchored on the stage test, not on the message, so rewording the error
  // keeps the test green while deleting the guard does not.
  assert(
    /blockRow\.stage === "composite"/.test(EVAL),
    "grading-eval.ts must refuse a composite block candidate outright — " +
      "without it the gate scores the champion and stamps the candidate's name " +
      "on the result",
  );
});

Deno.test("US-2438: the refusal happens BEFORE the run spends anything", () => {
  // A refusal after the images download and the vision calls fire is a refusal
  // that costs money to reach. It has to precede the case loop.
  const guard = EVAL.indexOf('blockRow.stage === "composite"');
  const spend = EVAL.indexOf("await analyzeImage(");
  assert(guard > -1 && spend > -1, "anchors moved");
  assert(
    guard < spend,
    "the composite-block refusal must come before the first vision call",
  );
});

Deno.test("US-2438: the block override still reaches the PER-IMAGE call", () => {
  // The other half. Refusing composite must not have disarmed the leg that
  // works — a per-image block candidate is the one thing this gate can measure.
  const call = EVAL.slice(EVAL.indexOf("await analyzeImage("));
  assert(
    call.slice(0, 600).includes("blockOverride"),
    "analyzeImage must still receive blockOverride for per-image candidates",
  );
});

Deno.test("US-2438: compositeGrade does not silently accept a block override", () => {
  // The refusal above is only safe while this stays true. If compositeGrade
  // grows a block-override parameter and grading-eval.ts is not updated in the
  // same commit, the guard becomes a lie in the other direction — refusing a
  // candidate the engine could now actually measure.
  const sig = AI.slice(
    AI.indexOf("export async function compositeGrade("),
    AI.indexOf("): Promise<CompositeGradeResult> {"),
  );
  assert(
    !/blockOverride|PromptBlockOverrides/.test(sig),
    "compositeGrade now takes a block override — lift the refusal in " +
      "grading-eval.ts in this same commit, and give composite blocks a shadow " +
      "leg before calling them gate-qualified (US-2438 AC2)",
  );
});
