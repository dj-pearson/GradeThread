// US-3521: refuse to grade on an unevaluated prompt, only when enforced, and
// never silently when overridden.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  _setPromptGateBlockedForTest,
  promptGateBlocked,
  promptGateDecision,
  refreshPromptGate,
} from "../lib/prompt-serving-gate.ts";
import { gradingUnavailableBody, gradingUnavailableReason } from "../lib/grading-availability.ts";

const U = [{ stage: "composite", version: "composite_v4", reason: "never evaluated" }];

Deno.test("US-3521: nothing unevaluated passes quietly", () => {
  assertEquals(promptGateDecision([], "enforce", undefined), { block: false, log: null });
});

Deno.test("US-3521: enforced and unevaluated refuses", () => {
  const d = promptGateDecision(U, "enforce", undefined);
  assert(d.block);
  assert(d.log?.includes("composite=composite_v4"));
});

Deno.test("US-3521: an override serves, and says why in the log", () => {
  const d = promptGateDecision(U, "enforce", "golden set not seeded yet");
  assertEquals(d.block, false);
  assert(d.log?.includes("OVERRIDE") && d.log.includes("golden set not seeded yet"));
});

Deno.test("US-3521: not enforced (the default) never refuses", () => {
  assertEquals(promptGateDecision(U, undefined, undefined).block, false);
  assertEquals(promptGateDecision(U, "warn", undefined).block, false);
});

Deno.test("US-3521: a blocked gate refuses before charge with its own message", () => {
  assertEquals(gradingUnavailableReason("closed", 0, 24, true), "prompt_unevaluated");
  assertEquals(gradingUnavailableReason("closed", 0, 24), null);
  assertEquals(gradingUnavailableBody("prompt_unevaluated").code, "GRADING_PAUSED");
});

Deno.test("US-3521: a failed check keeps the previous state", async () => {
  const prior = Deno.env.get("GRADING_PROMPT_EVAL_GATE");
  try {
    Deno.env.set("GRADING_PROMPT_EVAL_GATE", "enforce");
    await refreshPromptGate(() => Promise.resolve(U));
    assertEquals(promptGateBlocked(), true);
    await refreshPromptGate(() => Promise.reject(new Error("db down")));
    assertEquals(promptGateBlocked(), true);
    await refreshPromptGate(() => Promise.resolve([]));
    assertEquals(promptGateBlocked(), false);
  } finally {
    _setPromptGateBlockedForTest(false);
    if (prior === undefined) Deno.env.delete("GRADING_PROMPT_EVAL_GATE");
    else Deno.env.set("GRADING_PROMPT_EVAL_GATE", prior);
  }
});
