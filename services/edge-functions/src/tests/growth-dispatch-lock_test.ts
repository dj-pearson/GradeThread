// US-2316: growth-dispatch was the only bulk-email job with no lock.
//
// Four things were wrong at once, and they compound:
//
//   1. No job lock, on a */15 schedule. dispatchCampaign's "already in
//      progress" 409 is deliberately BYPASSED on the resume path — which is
//      exactly the path two overlapping ticks take — so nothing serialised
//      them. Each tick loads its own done-set snapshot at start, so any
//      recipient tick 1 finalises AFTER tick 2 took its snapshot gets a second
//      copy of the email.
//   2. No try/catch around either dispatch loop, so ONE throwing campaign
//      aborted the handler and every campaign queued behind it.
//   3. The done-set pre-load was a single unbounded select. PostgREST clips at
//      db-max-rows and says so only in a header supabase-js drops, so on a
//      large campaign the done set silently lost its tail — and the tail is
//      precisely the set of people who then get emailed twice.
//   4. The response carried per-campaign {ok} flags but no failure COUNT.
//      US-2312's cron ledger reads NAMED counters, so a tick in which every
//      campaign failed recorded as a success with rows_processed 0.
//
// Source-scanned rather than driven, because exercising it needs SES plus a
// seeded campaign. What can be checked here is that each guard is present, and
// each is a single line that is easy to lose in a refactor.

import { assert } from "@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../routes/admin-growth.ts", import.meta.url),
);

/** The growth-dispatch cron handler body. */
function handler(): string {
  const at = SRC.indexOf("export async function handleGrowthDispatchCron");
  assert(at > -1, "handleGrowthDispatchCron not found — renamed?");
  const end = SRC.indexOf("\nexport ", at + 10);
  return SRC.slice(at, end === -1 ? undefined : end);
}

Deno.test("US-2316: growth-dispatch takes a job lock", () => {
  const h = handler();
  assert(
    /acquireJobLock\(\s*"growth-dispatch"/.test(h),
    "the only unlocked bulk-email job is unlocked again",
  );
  assert(
    /if \(!lock\.acquired\)/.test(h),
    "the lock is taken but not honoured — a failed acquire must skip the tick",
  );
  assert(h.includes("lock.release()"), "the lock is never released");
});

Deno.test("US-2316: the lease outlives the schedule", () => {
  // The job runs every 15 minutes and the bug is a tick that OVERRUNS its own
  // interval. A lease shorter than the work would expire mid-send and hand the
  // campaign to the next tick — recreating the overlap the lock exists to stop.
  const m = /acquireJobLock\(\s*"growth-dispatch",\s*(\d+)\)/.exec(handler());
  assert(m, "could not read the lease duration");
  assert(
    Number(m[1]) > 15 * 60,
    `lease ${m[1]}s is not longer than the 15-minute schedule`,
  );
});

Deno.test("US-2316: one failing campaign cannot abort the rest of the tick", () => {
  const h = handler();
  assert(
    /try \{[\s\S]*?dispatchCampaign\(/.test(h),
    "dispatchCampaign is called outside a try — one throw kills the whole tick",
  );
  assert(
    /catch \(err\)[\s\S]*?ok: false/.test(h),
    "a thrown campaign is no longer recorded as failed",
  );
});

Deno.test("US-2316: the response carries a NAMED failure count", () => {
  // Without this the cron ledger's alerting cannot see a total failure: it
  // matches named counters, and an array of {ok:false} matches none of them.
  const h = handler();
  assert(/failed,/.test(h) || /failed:/.test(h), "no `failed` counter in the response");
  assert(
    /const failed = dispatched\.filter\(\(d\) => !d\.ok\)\.length/.test(h),
    "the failed count is no longer derived from the dispatch results",
  );
});

Deno.test("US-2316: the done-set is paged, not a single unbounded read", () => {
  // The duplicate-send vector. A truncated done set is indistinguishable from
  // a complete one, and every recipient in the lost tail is emailed again.
  const at = SRC.indexOf("const done = new Set<string>()");
  assert(at > -1, "the done-set pre-load is gone");
  const block = SRC.slice(at, at + 1800);
  assert(block.includes("fetchAllPages"), "the done-set read is unbounded again");
  assert(
    block.includes('.order("user_id"'),
    "paging without an ORDER BY can skip a row at a page boundary",
  );
});
