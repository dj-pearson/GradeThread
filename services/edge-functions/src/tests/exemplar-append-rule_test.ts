// US-1643: the live few-shot exemplar block must be appended to the composite
// prompt ONLY when grading a real submission with the active prompt — never on
// an eval / dry-run / shadow leg (override set, or exemplars explicitly
// suppressed). ai-grading.ts transitively imports the service-role supabase
// client (reads env at module load), so set dummy env FIRST then dynamic-import.
import { assert } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { shouldAppendActiveExemplars } = await import("../lib/ai-grading.ts");

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
