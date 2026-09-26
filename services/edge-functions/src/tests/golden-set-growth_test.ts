// US-3522: the eval gate refuses a golden set too small or too narrow to mean
// anything, and big human corrections queue themselves as candidates.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { autoQueueEvalCandidate, goldenSetGaps, GRADE_TIERS } = await import(
  "../lib/grading-eval.ts"
);

const everyTier = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => ({ expected_tier: GRADE_TIERS[i % GRADE_TIERS.length] }),
  );

Deno.test("US-3522: 20 cases spanning every tier is enough", () => {
  assertEquals(goldenSetGaps(everyTier(20), { scoped: false }), []);
});

Deno.test("US-3522: three tops rated Good is refused, naming both gaps", () => {
  const gaps = goldenSetGaps(
    [{ expected_tier: "Good" }, { expected_tier: "Good" }, {
      expected_tier: "Good",
    }],
    { scoped: false },
  );
  assertEquals(gaps.length, 2);
  assert(gaps[0]!.includes("3 active cases, need 20"));
  assertEquals(gaps[1], "no case in tier NWT, NWOT, Excellent, Very Good, Fair, Poor");
});

Deno.test("US-3522: a big set missing one tier is still refused", () => {
  const cases = Array.from(
    { length: 40 },
    () => ({ expected_tier: "Excellent" }),
  );
  for (const t of GRADE_TIERS.filter((t) => t !== "Poor")) {
    cases.push({ expected_tier: t });
  }
  assertEquals(goldenSetGaps(cases, { scoped: false }), [
    "no case in tier Poor",
  ]);
});

Deno.test("US-3522: a scoped run needs 5 cases and no tier spread", () => {
  assertEquals(
    goldenSetGaps(everyTier(4).map(() => ({ expected_tier: "Good" })), {
      scoped: true,
    }).length,
    1,
  );
  assertEquals(
    goldenSetGaps(Array(5).fill({ expected_tier: "Good" }), { scoped: true }),
    [],
  );
});

Deno.test("US-3522: the minimums are env-tunable and junk falls back", () => {
  Deno.env.set("GRADING_EVAL_MIN_CASES", "7");
  try {
    assertEquals(goldenSetGaps(everyTier(7), { scoped: false }), []);
    Deno.env.set("GRADING_EVAL_MIN_CASES", "zero");
    assertEquals(goldenSetGaps(everyTier(7), { scoped: false }), [
      "7 active cases, need 20",
    ]);
  } finally {
    Deno.env.delete("GRADING_EVAL_MIN_CASES");
  }
});

Deno.test("US-3522: a correction of a point or more is queued; a small one is not", async () => {
  const calls: string[] = [];
  const promote = (id: string) => {
    calls.push(id);
    return Promise.resolve({
      ok: true as const,
      case_id: "c1",
      already: false,
    });
  };
  const base = { original_score: 8.2, intentional_misread: null };
  assertEquals(
    await autoQueueEvalCandidate(
      { ...base, grade_report_id: "big", adjusted_score: 7.1 },
      "human_review",
      "a",
      promote,
    ),
    "queued",
  );
  assertEquals(
    await autoQueueEvalCandidate(
      { ...base, grade_report_id: "small", adjusted_score: 7.8 },
      "human_review",
      "a",
      promote,
    ),
    "skipped",
  );
  assertEquals(
    await autoQueueEvalCandidate(
      {
        grade_report_id: "misread",
        original_score: 6,
        adjusted_score: 6,
        intentional_misread: true,
      },
      "human_review",
      "a",
      promote,
    ),
    "queued",
  );
  assertEquals(calls, ["big", "misread"]);
});

Deno.test("US-3522: a promotion failure never throws into the review", async () => {
  const boom = () => Promise.reject(new Error("db down"));
  assertEquals(
    await autoQueueEvalCandidate(
      {
        grade_report_id: "x",
        original_score: 9,
        adjusted_score: 7,
        intentional_misread: null,
      },
      "dispute",
      null,
      boom,
    ),
    "failed",
  );
});

Deno.test("US-3522: both correction routes queue, and runEval checks the gaps before grading", async () => {
  for (
    const f of ["../routes/admin-grading.ts", "../routes/admin-disputes.ts"]
  ) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    assert(src.includes("void autoQueueEvalCandidate("), f);
  }
  const ev = await Deno.readTextFile(
    new URL("../lib/grading-eval.ts", import.meta.url),
  );
  const gapAt = ev.indexOf("const gaps = goldenSetGaps(");
  const modelAt = ev.indexOf("US-2307: the eval runs on, and stamps");
  assert(
    gapAt > 0 && gapAt < modelAt,
    "gap check sits before any grading work",
  );
});

// US-3523: repeated eval runs, scored on the mean.
const { evalRepeats, meanOfRuns } = await import("../lib/grading-eval.ts");

Deno.test("US-3523: eval repeats default to 1, cap at 5, and ignore junk", () => {
  Deno.env.delete("GRADING_EVAL_REPEATS");
  assertEquals(evalRepeats(), 1);
  for (const [v, want] of [["3", 3], ["9", 5], ["0", 1], ["x", 1], ["2.7", 2]] as const) {
    Deno.env.set("GRADING_EVAL_REPEATS", v);
    assertEquals(evalRepeats(), want, v);
  }
  Deno.env.delete("GRADING_EVAL_REPEATS");
});

Deno.test("US-3523: a case is scored on the mean of its runs, on the 0.1 grid", () => {
  assertEquals(meanOfRuns([7.0, 7.8]), 7.4);
  assertEquals(meanOfRuns([8.1, 8.2, 8.2]), 8.2);
  assert(Number.isNaN(meanOfRuns([])));
});

Deno.test("US-3523: runEval grades each case `repeats` times before scoring", async () => {
  const ev = await Deno.readTextFile(new URL("../lib/grading-eval.ts", import.meta.url));
  const loop = ev.slice(ev.indexOf("const repeats = evalRepeats();"));
  assert(loop.indexOf("for (let rep = 0; rep < repeats; rep++) {") > 0);
  assert(loop.indexOf("runs.push(result.overall_score);") < loop.indexOf("const predicted = meanOfRuns(runs);"));
});
