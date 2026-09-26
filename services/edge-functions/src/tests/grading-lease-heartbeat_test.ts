// US-3531: a running grade renews its lease, and one sweep resumes a bounded
// number of stuck grades.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { startLeaseHeartbeat } from "../lib/grading-lease-heartbeat.ts";
import {
  maxResumesPerSweep,
  recoverStuckSubmissions,
} from "../lib/stuck-submissions.ts";

Deno.test("US-3531: the heartbeat renews every third of a lease until stopped", async () => {
  const renewals: Array<[string, string]> = [];
  let tick: (() => void) | null = null;
  let scheduledEvery = 0;
  let cancelled = false;
  const stop = startLeaseHeartbeat(
    "s1",
    900,
    (id, until) => {
      renewals.push([id, until]);
      return Promise.resolve();
    },
    (fn, ms) => {
      tick = fn;
      scheduledEvery = ms;
      return 7;
    },
    () => {
      cancelled = true;
    },
    () => Date.parse("2026-09-26T12:00:00Z"),
  );
  assertEquals(scheduledEvery, 300_000);
  tick!();
  tick!();
  await Promise.resolve();
  assertEquals(renewals.length, 2);
  assertEquals(renewals[0], ["s1", "2026-09-26T12:15:00.000Z"]);
  stop();
  stop();
  assertEquals(cancelled, true);
});

Deno.test("US-3531: a renew failure never throws into the grade", async () => {
  let tick: (() => void) | null = null;
  const stop = startLeaseHeartbeat(
    "s1",
    900,
    () => Promise.reject(new Error("db down")),
    (fn) => {
      tick = fn;
      return 1;
    },
    () => {},
  );
  tick!();
  await Promise.resolve();
  stop();
});

Deno.test("US-3531: a sweep resumes at most 12, defers the rest, and still fails poison", async () => {
  assertEquals(maxResumesPerSweep(), 12);
  const stuck = [
    ...Array.from(
      { length: 30 },
      (_, i) => ({ id: `r${i}`, grading_attempts: 0 }),
    ),
    { id: "poison", grading_attempts: 99 },
  ];
  const resumed: string[] = [];
  const failed: string[] = [];
  const res = await recoverStuckSubmissions({
    findStuck: () => Promise.resolve(stuck),
    resume: (id) => {
      resumed.push(id);
    },
    failAndRefund: (id) => {
      failed.push(id);
      return Promise.resolve(true);
    },
  });
  assertEquals(resumed.length, 12);
  assertEquals(res.deferred, 18);
  assertEquals(failed, ["poison"]);
});

Deno.test("US-3531: the pipeline starts the heartbeat after the claim and stops it in finally", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  const fn = src.slice(src.indexOf("export async function processSubmission("));
  const claim = fn.indexOf("await claimSubmissionForGrading(submissionId)");
  const start = fn.indexOf(
    "startLeaseHeartbeat(submissionId, gradingLeaseSeconds())",
  );
  assert(claim > 0 && start > claim);
  assert(fn.includes("} finally {\n    stopHeartbeat();\n  }"));
});
