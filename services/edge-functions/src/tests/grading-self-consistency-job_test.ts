// US-2035: the reproducibility sampler is wired, bounded, and off by default.
//
//   deno test --allow-env --allow-read src/tests/grading-self-consistency-job_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { CRON_REGISTRY } from "../lib/cron-runs.ts";

const SRC = Deno.readTextFileSync(
  new URL("../routes/jobs-grading-self-consistency.ts", import.meta.url),
);
const MAIN = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));
const RELIABILITY = Deno.readTextFileSync(
  new URL("../lib/grading-reliability.ts", import.meta.url),
);

Deno.test("US-2035: the job is mounted, so the math finally has a caller", () => {
  // grading-reliability.ts was written, tested, and called by nothing — the
  // determinism promise had no decoder enforcing it AND no measurement telling
  // anyone. Being mounted is the whole point of this story's second half.
  assert(MAIN.includes("/api/jobs/grading-self-consistency"));
  assert(MAIN.includes("handleGradingSelfConsistencyCron"));
  assert(SRC.includes("assessSelfConsistency"), "the job does not use the shared math");
});

Deno.test("US-2035: it is registered as a cron so its absence is visible", () => {
  const job = CRON_REGISTRY.find((j) => j.name === "grading-self-consistency");
  assert(job, "not in the cron registry — a job nobody schedules is a job nobody runs");
  assertEquals(job.endpoint, "/api/jobs/grading-self-consistency");
  assertEquals(job.recorded, true, "must record a run, or a silent failure is invisible");
});

Deno.test("US-2035: sampling is OFF unless someone opts in", () => {
  // Every sample costs vision calls. A default-on measurement job is a bill
  // nobody approved, and it would be discovered from the invoice.
  assert(
    /GRADING_SELF_CONSISTENCY_SAMPLE", 0\)/.test(SRC),
    "the sample size no longer defaults to 0",
  );
  assert(SRC.includes('skipped: "disabled"'));
});

Deno.test("US-2035: the sample is capped whatever the env says", () => {
  // An env var read straight into a loop that makes vision calls is one typo
  // away from an unbounded bill.
  assert(SRC.includes("MAX_SAMPLE"));
  assert(/Math\.min\(envInt\("GRADING_SELF_CONSISTENCY_SAMPLE", 0\), MAX_SAMPLE\)/.test(SRC));
});

Deno.test("US-2035: at least two runs, or there is no spread to measure", () => {
  // One grade per item cannot disagree with itself, and the report would read
  // as perfectly consistent — the most misleading possible output.
  assert(/Math\.max\(2, envInt\("GRADING_SELF_CONSISTENCY_RUNS"/.test(SRC));
});

Deno.test("US-2035: it takes the job lock, so two replicas cannot double the bill", () => {
  assert(SRC.includes('acquireJobLock("grading-self-consistency"'));
});

Deno.test("US-2035: images are read through signed URLs, never a public one", () => {
  // submission-images is private (US-276). A measurement job is not a reason to
  // reach for getPublicUrl.
  assert(SRC.includes("createSignedUrl"));
  assertEquals(SRC.includes("getPublicUrl"), false);
});

Deno.test("US-2035: one bad sample does not sink the run, and is counted", () => {
  // A report built from three of twenty samples must not read as twenty.
  assert(SRC.includes("failures.push"));
  assert(/failures:\s*failures\.length/.test(SRC));
});

Deno.test("US-2035: divergence raises an ops event rather than only a log line", () => {
  assert(SRC.includes("emitOpsEvent"));
  assert(SRC.includes("grading_self_consistency_divergence"));
});

Deno.test("US-2035: the reliability module no longer claims to be unwired", () => {
  // It said "ZERO non-test callers" for a reason, and that sentence would be
  // false now — the exact shape of stale comment this story exists to fix.
  assertEquals(
    /ZERO\s*\n?\/\/ non-test callers/.test(RELIABILITY),
    false,
    "grading-reliability.ts still describes itself as having no callers",
  );
  assert(RELIABILITY.includes("WIRED 2026-08-15"));
});
