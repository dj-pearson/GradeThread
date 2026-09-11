// US-3305: which models take output_config.effort, asserted against the model
// documentation rather than against whatever the code currently believes.
//
// THE DEFECT THIS EXISTS FOR: modelUsesEffort() was a list of startsWith()
// prefixes and claude-opus-5 was not on it. Opus 5 takes effort low..max, so
// every call routed to it through effortParams / outputConfigParams went out
// with NO effort and ran at the model's own default. Nothing reported it. A
// dropped parameter looks exactly like a parameter nobody set, which is why it
// survived a release.
//
// So this file does three things a prefix list cannot check itself:
//   1. pins the real support matrix, model by model;
//   2. proves the effort key SURVIVES all the way through outputConfigParams
//      (where US-3151 already showed one composition bug can eat it silently);
//   3. proves the rule answers for ids that do not exist yet, which is the only
//      reason it is a rule instead of a list.

// US-2379: first, before anything that reaches lib/supabase.ts at import time.
import "./_env.ts";

import { assert, assertEquals } from "@std/assert";
import {
  classifyEffortSupport,
  CONTENT_MODEL_ALLOWLIST_FOR_TESTS,
  CURRENT_MODEL_IDS,
  effortParams,
  GRADING_MODEL_ALLOWLIST,
  modelUsesEffort,
  outputConfigParams,
  resetEffortWarningsForTests,
} from "../lib/ai-config.ts";

// The support matrix as the Anthropic model documentation states it (read
// 2026-09-10). `true` means the model accepts output_config.effort; `false`
// means it rejects it with a 400.
//
// Sonnet 4.6 is `true` and used to be asserted `false` in ai-effort-params_test
// - that assertion recorded the old prefix list's belief, not the API's
// behaviour. Effort arrived on Sonnet at 4.6 and on Opus at 4.5; no released
// Haiku accepts it; every Fable / Mythos does.
const SUPPORT_MATRIX: ReadonlyArray<readonly [string, boolean]> = [
  ["claude-opus-5", true], // the regression this story is about
  ["claude-opus-4-8", true],
  ["claude-opus-4-7", true],
  ["claude-opus-4-6", true],
  ["claude-opus-4-5", true],
  ["claude-sonnet-5", true],
  ["claude-sonnet-4-6", true],
  ["claude-fable-5", true],
  ["claude-fable-5-1", true],
  ["claude-mythos-5-1", true],
  ["claude-haiku-4-5", false],
  ["claude-haiku-4-5-20251001", false],
  ["claude-sonnet-4-5", false],
  ["claude-3-5-haiku-20241022", false],
  ["claude-3-7-sonnet-20250219", false],
];

const SCHEMA = { type: "object", properties: {}, additionalProperties: false };

Deno.test("US-3305: the effort match agrees with the published support matrix", () => {
  for (const [model, takesEffort] of SUPPORT_MATRIX) {
    assertEquals(
      classifyEffortSupport(model),
      takesEffort ? "yes" : "no",
      `${model} is classified wrongly - check EFFORT_BY_FAMILY in lib/ai-config.ts`,
    );
    assertEquals(
      modelUsesEffort(model),
      takesEffort,
      `modelUsesEffort("${model}") should be ${takesEffort}`,
    );
  }
});

Deno.test("US-3305: effort SURVIVES outputConfigParams for every model that takes it", () => {
  for (const [model, takesEffort] of SUPPORT_MATRIX) {
    const cfg = outputConfigParams(model, "content_blog", "medium", SCHEMA)
      .output_config;

    // The schema goes out on every model - structured outputs and effort are
    // independent features (US-3151).
    assertEquals(cfg.format, { type: "json_schema", schema: SCHEMA }, model);

    if (takesEffort) {
      assertEquals(
        cfg.effort,
        "medium",
        `${model} takes effort but outputConfigParams dropped it - this is the ` +
          `US-3305 failure, and the call would still succeed at the default effort`,
      );
      assertEquals(effortParams(model, "content_blog", "medium"), {
        output_config: { effort: "medium" },
      });
    } else {
      assertEquals(
        cfg.effort,
        undefined,
        `${model} rejects effort with a 400; sending it breaks every call`,
      );
      assertEquals(effortParams(model, "content_blog", "medium"), {});
    }
  }
});

Deno.test("US-3305: every model an operator can actually route to is classified", () => {
  // The union of every id this build can be pointed at. If one of them is
  // "unknown", the helper is guessing on live traffic.
  const routable = new Set<string>([
    ...CURRENT_MODEL_IDS,
    ...CONTENT_MODEL_ALLOWLIST_FOR_TESTS,
    ...GRADING_MODEL_ALLOWLIST,
  ]);
  const matrix = new Map(SUPPORT_MATRIX.map(([m, v]) => [m, v]));

  for (const model of routable) {
    const verdict = classifyEffortSupport(model);
    assert(
      verdict !== "unknown",
      `${model} is routable but unclassified for output_config.effort`,
    );
    const expected = matrix.get(model);
    assert(
      expected !== undefined,
      `${model} is routable but missing from SUPPORT_MATRIX above - add it ` +
        `with its documented answer rather than letting the rule go unchecked`,
    );
    assertEquals(modelUsesEffort(model), expected, model);
  }

  // Named explicitly so dropping Opus 5 from the match fails here even if the
  // loops above are ever loosened.
  assert(CURRENT_MODEL_IDS.has("claude-opus-5"));
  assert(modelUsesEffort("claude-opus-5"));
});

Deno.test("US-3305: the rule answers for ids that do not exist yet", () => {
  // This is the entire argument for a rule over a hand-maintained list. Every
  // one of these would need an edit under the old prefix list, and forgetting
  // the edit is invisible - which is how Opus 5 lost its effort setting.
  for (const future of [
    "claude-opus-5-1",
    "claude-opus-6",
    "claude-sonnet-5-1",
    "claude-sonnet-6",
    "claude-fable-6",
    "claude-mythos-6",
  ]) {
    assertEquals(classifyEffortSupport(future), "yes", future);
  }

  // And it still says no to an older id in a family that gained effort later.
  assertEquals(classifyEffortSupport("claude-sonnet-4-0"), "no");
  assertEquals(classifyEffortSupport("claude-opus-4-1"), "no");
});

Deno.test("US-3305: an unrecognised model is reported OUT LOUD, not silently answered", () => {
  resetEffortWarningsForTests();
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    // A family this build has never classified, and a Haiku newer than any that
    // has been checked: both are guesses, and a guess has to be audible.
    assertEquals(classifyEffortSupport("claude-quasar-1"), "unknown");
    assertEquals(classifyEffortSupport("claude-haiku-6"), "unknown");
    assertEquals(classifyEffortSupport("{{team.DEFAULT_AI_MODEL}}"), "unknown");

    // It still returns false, because a wrong "yes" 400s every call while a
    // wrong "no" only costs the setting - but it says so first.
    assertEquals(modelUsesEffort("claude-quasar-1"), false);
    assert(
      lines.some((l) => l.includes("claude-quasar-1")),
      `an unclassified model must be logged; got ${JSON.stringify(lines)}`,
    );

    // Warn-once: a per-call log on a hot path is its own outage.
    const after = lines.length;
    modelUsesEffort("claude-quasar-1");
    assertEquals(lines.length, after);
  } finally {
    console.error = original;
    resetEffortWarningsForTests();
  }
});
