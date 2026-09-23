// An edited prompt version loses its eval pass.
//
// PATCH /prompts/:id refuses text edits on ACTIVE rows only. An inactive row
// that already passed the eval could have its prompt_text or garment_scope
// rewritten and then be activated or canaried on the old verdict, because both
// gates read eval_passed as it stands. evalResetForPromptEdit is the rule; the
// route wiring guard below is what makes the route use it.
//
//   deno test --allow-env --allow-read src/tests/prompt-edit-eval-reset_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  checkPromptServingEligibility,
  evalResetForPromptEdit,
} from "../lib/grading-eval.ts";

const PASSED = {
  prompt_text: "Grade the garment.",
  garment_scope: null as string | null,
  eval_passed: true as boolean | null,
  qualified_model: "model-a" as string | null,
  eval_run_id: "run-1" as string | null,
};
const CLEARED = { eval_passed: null, qualified_model: null, eval_run_id: null };

Deno.test("changed prompt_text clears the eval verdict", () => {
  assertEquals(
    evalResetForPromptEdit(PASSED, { prompt_text: "Grade the garment harshly." }),
    CLEARED,
  );
});

Deno.test("changed garment_scope clears the eval verdict", () => {
  assertEquals(evalResetForPromptEdit(PASSED, { garment_scope: "footwear" }), CLEARED);
  assertEquals(
    evalResetForPromptEdit({ ...PASSED, garment_scope: "footwear" }, { garment_scope: null }),
    CLEARED,
  );
});

Deno.test("same text, same scope, name or notes only: verdict kept", () => {
  assertEquals(evalResetForPromptEdit(PASSED, { prompt_text: PASSED.prompt_text }), {});
  assertEquals(evalResetForPromptEdit(PASSED, { garment_scope: null }), {});
  assertEquals(evalResetForPromptEdit(PASSED, {}), {});
  assertEquals(
    evalResetForPromptEdit(PASSED, { version_name: "v2", notes: "x" } as Record<string, unknown>),
    {},
  );
});

Deno.test("an edited row can no longer pass the serving gate", () => {
  assert(checkPromptServingEligibility(PASSED, "model-a").ok, "precondition: row serves before edit");
  const edited = { ...PASSED, ...evalResetForPromptEdit(PASSED, { prompt_text: "new" }) };
  const verdict = checkPromptServingEligibility(edited, "model-a");
  assertEquals(verdict.ok, false);
});

Deno.test("the helper never emits a promoting field", () => {
  const out = evalResetForPromptEdit(PASSED, { prompt_text: "new", garment_scope: "tops" });
  assertEquals(Object.keys(out).sort(), ["eval_passed", "eval_run_id", "qualified_model"]);
});

Deno.test("PATCH /prompts/:id applies the reset before it writes", () => {
  const src = Deno.readTextFileSync(new URL("../routes/admin-grading.ts", import.meta.url));
  const start = src.indexOf('adminGradingRoutes.patch("/prompts/:id",');
  assert(start > 0, "PATCH /prompts/:id route not found");
  const write = src.indexOf(".update(patch)", start);
  assert(write > start, "PATCH /prompts/:id no longer writes .update(patch)");
  const body = src.slice(start, write);
  assert(
    /Object\.assign\(\s*patch\s*,\s*evalResetForPromptEdit\(\s*existing\s*,\s*patch\s*\)\s*\)/.test(body),
    "PATCH /prompts/:id must merge evalResetForPromptEdit(existing, patch) into the update, " +
      "or an evaluated prompt can be edited and then served on its old pass",
  );
  // The comparison needs the stored scope, not just the stored text.
  const select = body.match(/\.select\("([^"]+)"\)/);
  assert(select && /\bgarment_scope\b/.test(select[1]), "the existing-row read must select garment_scope");
});
