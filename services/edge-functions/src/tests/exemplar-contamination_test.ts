// US-2034: train/test separation between the golden eval set and the few-shot
// exemplar pool.
//
// Both are mined from the SAME corrected human reviews. Before the fix, one
// corrected report could be both a golden case and an exemplar in the prompt
// block — so evalExemplarSet scored a candidate set against cases whose answers
// it had been shown. The gate reports inflated agreement and deflated MAE, an
// exemplar set that does not generalize gets activated, and real customer
// garments are graded by a prompt whose measured quality was fictitious.
//
// The fix shipped with NO test. A contamination bug that is fixed but unguarded
// is one refactor away from returning, and its symptom is a number that looks
// BETTER than the truth — the failure mode nobody investigates.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { separateGoldenSources } = await import("../lib/few-shot-exemplars.ts");

const cand = (...ids: string[]) => ids.map((grade_report_id) => ({ grade_report_id }));
const golden = (...ids: (string | null)[]) =>
  ids.map((source_grade_report_id) => ({ source_grade_report_id }));

Deno.test("US-2034: a report in the golden set never enters the exemplar pool", () => {
  const { kept, excludedCount } = separateGoldenSources(
    cand("r1", "r2", "r3"),
    golden("r2"),
  );
  assertEquals(kept.map((k) => k.grade_report_id), ["r1", "r3"]);
  assertEquals(excludedCount, 1);
});

Deno.test("US-2034: an uncontaminated pool passes through untouched", () => {
  const { kept, excludedCount } = separateGoldenSources(
    cand("r1", "r2"),
    golden("r9"),
  );
  assertEquals(kept.length, 2);
  assertEquals(excludedCount, 0);
});

Deno.test("US-2034: null source ids never exclude anything", () => {
  // grading_eval_cases.source_grade_report_id is nullable — a hand-authored
  // case has no originating report. A null must not collapse into a match and
  // silently empty the exemplar pool.
  const { kept, excludedCount } = separateGoldenSources(
    cand("r1", "r2"),
    golden(null, null),
  );
  assertEquals(kept.length, 2);
  assertEquals(excludedCount, 0);
});

Deno.test("US-2034: total overlap yields an EMPTY pool, not a partial one", () => {
  // Assembling from a fully-contaminated pool must produce nothing rather than
  // quietly falling back to the contaminated candidates.
  const { kept, excludedCount } = separateGoldenSources(
    cand("r1", "r2"),
    golden("r1", "r2"),
  );
  assertEquals(kept, []);
  assertEquals(excludedCount, 2);
});

Deno.test("US-2034: duplicate golden sources are counted once", () => {
  // The query does not dedupe: several eval cases can share one source report.
  // excludedCount must describe CANDIDATES removed, not golden rows seen, or
  // the log line misreports the contamination.
  const { kept, excludedCount } = separateGoldenSources(
    cand("r1", "r2"),
    golden("r1", "r1", "r1"),
  );
  assertEquals(kept.map((k) => k.grade_report_id), ["r2"]);
  assertEquals(excludedCount, 1);
});

// ── The surrounding IO contract, which the pure function cannot cover ──

const SRC = Deno.readTextFileSync(
  new URL("../lib/few-shot-exemplars.ts", import.meta.url),
);

Deno.test("US-2034: the golden-source lookup FAILS CLOSED", () => {
  // Assembling a set while unable to prove it is uncontaminated produces a
  // number nobody can trust, which defeats the gate's entire purpose. A
  // swallowed error here would silently restore the original bug.
  assert(
    /goldenError[\s\S]{0,400}?throw new Error/.test(SRC),
    "a failed golden-source lookup must throw, never fall through to assembly",
  );
});

Deno.test("US-2034: the exclusion query is not narrowed by active/deleted state", () => {
  // Over-exclusion is the safe direction: an inactive or soft-deleted case can
  // be reactivated, and a set contaminated at assembly time cannot be
  // decontaminated afterwards. Narrowing this query would look like a tidy-up
  // and would quietly re-open the hole.
  const query = SRC.match(
    /from\("grading_eval_cases"\)[\s\S]{0,300}?;/,
  )?.[0] ?? "";
  assert(query.includes("source_grade_report_id"), "query not found");
  assert(
    !query.includes("is_active") && !query.includes("deleted_at"),
    `the golden-source exclusion must consider ALL cases; found: ${query}`,
  );
});
