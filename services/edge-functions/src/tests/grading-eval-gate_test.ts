// US-2301 AC6: the number a candidate prompt has to beat before it may serve
// live traffic.
//
// It shipped at a mean absolute error of 1.0 on a 1.0-10.0 scale, where the
// weighted overall is rounded to 0.1. A full point is an entire grade — the gap
// between Excellent and Good — so a candidate could be that wrong on average
// and still be promoted, on the one number the product sells.
//
// Owner's call 2026-08-15: 0.5. Half a grade point is one tier rather than two,
// and still generous. 0.3 was considered and refused for now: it is close to the
// disagreement between two human experts, and the golden set is not yet large
// enough to distinguish a real regression from an unrepresentative sample.
//
// This test exists because the value is a DEFAULT behind an env var, so nothing
// else would notice it drifting back — and because evalThresholds() also feeds
// the public transparency report, which prints the number as a promise.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { evalThresholds } = await import("../lib/grading-eval.ts");

function withEnv<T>(key: string, value: string | null, fn: () => T): T {
  const prev = Deno.env.get(key);
  if (value === null) Deno.env.delete(key);
  else Deno.env.set(key, value);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete(key);
    else Deno.env.set(key, prev);
  }
}

Deno.test("US-2301 AC6: the default max MAE is half a grade point, not a whole one", () => {
  const gate = withEnv("EVAL_MAX_MAE", null, () => evalThresholds());
  assertEquals(gate.max_mae, 0.5);
});

Deno.test("US-2301 AC6: an explicit override still wins, so an argued exception is one env var", () => {
  assertEquals(withEnv("EVAL_MAX_MAE", "0.8", () => evalThresholds()).max_mae, 0.8);
  assertEquals(withEnv("EVAL_MAX_MAE", "0.25", () => evalThresholds()).max_mae, 0.25);
});

Deno.test("US-2301 AC6: junk or a non-positive override falls back to the strict default", () => {
  // Fail-closed on the number that decides what serves live traffic. A typo in
  // an env var must not silently widen the gate — and 0 or a negative would
  // otherwise mean "no candidate can ever pass" or "every candidate passes",
  // depending on the comparison, which is worse than either.
  for (const junk of ["", "abc", "0", "-1", "NaN"]) {
    assertEquals(
      withEnv("EVAL_MAX_MAE", junk, () => evalThresholds()).max_mae,
      0.5,
      `value: ${junk}`,
    );
  }
});

Deno.test("US-2301 AC6: the agreement floor is unchanged", () => {
  // Only the MAE moved. Asserted so a future edit to this file cannot quietly
  // take the other half of the gate with it.
  assertEquals(withEnv("EVAL_MIN_AGREEMENT", null, () => evalThresholds()).min_agreement, 0.7);
});
