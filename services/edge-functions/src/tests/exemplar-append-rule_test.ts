// US-1643: the live few-shot exemplar block must be appended to the composite
// prompt ONLY when grading a real submission with the active prompt — never on
// an eval / dry-run / shadow leg (override set, or exemplars explicitly
// suppressed). ai-grading.ts transitively imports the service-role supabase
// client (reads env at module load), so set dummy env FIRST then dynamic-import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  shouldAppendActiveExemplars,
  composeExemplarPrompt,
  resolveActiveCompositePrompt,
  COMPOSITE_SYSTEM_PROMPT,
  COMPOSITE_PROMPT_VERSION,
} = await import("../lib/ai-grading.ts");

Deno.test("exemplars appended ONLY for a real grade: no override + not suppressed", () => {
  assert(shouldAppendActiveExemplars(false, false) === true);
});

Deno.test("an override leg (eval candidate) never appends the live exemplar block", () => {
  assert(shouldAppendActiveExemplars(true, false) === false);
});

Deno.test("an explicitly-suppressed leg (eval active / code-default) never appends", () => {
  assert(shouldAppendActiveExemplars(false, true) === false);
  assert(shouldAppendActiveExemplars(true, true) === false);
});

// US-1922: the exemplar eval gate must compose a candidate block onto the SAME
// base prompt the live grade path runs under, not the hard-coded default.

Deno.test("US-1922: composeExemplarPrompt composes block onto base; empty block → unchanged", () => {
  assertEquals(composeExemplarPrompt("BASE", "BLOCK"), "BASE\n\nBLOCK");
  assertEquals(composeExemplarPrompt("BASE", ""), "BASE"); // no active set → identical
});

Deno.test("US-1922: with no active DB override, the eval base == the live code default", async () => {
  // Dummy env → the ai_prompt_versions read falls back to the code default, so
  // resolveActiveCompositePrompt (used by BOTH the eval gate and the live path)
  // returns the code-default composite prompt. AC#2: behavior unchanged.
  const base = await resolveActiveCompositePrompt("dresses");
  assertEquals(base.text, COMPOSITE_SYSTEM_PROMPT);
  assertEquals(base.versionName, COMPOSITE_PROMPT_VERSION);

  // AC#1/#3: the eval gate now builds its candidate prompt from this resolved
  // base — the identical string the live default path composes onto — instead of
  // the hard-coded default. Both paths therefore compose onto the same base.
  const block = "EXEMPLAR-BLOCK";
  const evalComposed = composeExemplarPrompt(base.text, block);
  const liveDefaultComposed = composeExemplarPrompt(COMPOSITE_SYSTEM_PROMPT, block);
  assertEquals(evalComposed, liveDefaultComposed);
});
