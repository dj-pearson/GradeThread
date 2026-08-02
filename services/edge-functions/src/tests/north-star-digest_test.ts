// US-2314: the weekly North Star digest must not lose users.
//
// Two defects, both about ORDER rather than logic:
//
//   1. The north_star_weekly_log insert ran BEFORE the send, and that same row
//      is the next run's skip set. So a send that threw left the user marked
//      celebrated with no email.
//   2. The per-user loop had no try/catch and the handler is try/finally with
//      no catch, so a throw at user 50 of 1000 escaped to Hono — users 51-1000
//      got neither a log row nor an email.
//
// What makes both permanent is the week key: it is derived from now() on every
// run, so the following Monday computes a DIFFERENT key and the missed cohort is
// never revisited. Their digest and milestone mail is lost, not deferred.
//
// The handler reaches Supabase and the marketing coordinator at module scope,
// so these are source assertions on the ORDERING plus a behavioural model of the
// loop. The defects were an absent try/catch and a misplaced insert — neither
// has a wrong value to catch.

import { assert, assertEquals } from "@std/assert";

const src = await Deno.readTextFile(
  new URL("../routes/jobs-north-star.ts", import.meta.url),
);

Deno.test("US-2314: the weekly-log insert happens AFTER the send", () => {
  const sendAt = src.indexOf('category: "north_star_weekly"');
  // Regex, not a literal: indentation and line endings shift with deno fmt, and
  // a brittle match here would silently pass by finding nothing on both sides.
  const insertMatch = /from\("north_star_weekly_log"\)\s*\.insert\(/.exec(src);
  const insertAt = insertMatch?.index ?? -1;
  assert(sendAt > 0, "weekly send call not found");
  assert(insertAt > 0, "weekly-log insert not found");
  assert(
    insertAt > sendAt,
    "the log row is the next run's skip set — writing it before the send is " +
      "what marked a user celebrated who never received the email",
  );
});

Deno.test("US-2314: the per-user body is wrapped so one user cannot lose the cohort", () => {
  const loopAt = src.indexOf("for (const w of pending)");
  assert(loopAt > 0, "per-user loop not found");
  const loop = src.slice(loopAt);
  assert(loop.includes("try {"), "the per-user body must be wrapped");
  assert(
    loop.includes("jobs.north-star.user"),
    "a thrown user must be reported, not swallowed",
  );
  assert(loop.includes("failed++"), "a thrown user must be counted");
});

Deno.test("US-2314: the run reports a failed count the cron recorder can read", async () => {
  const outcome = await Deno.readTextFile(
    new URL("../lib/cron-run-outcome.ts", import.meta.url),
  );
  assert(
    outcome.includes('"failed"'),
    "failed must remain one of cron-run-outcome's FAILURE_KEYS",
  );
  assert(
    /return c\.json\(\{[\s\S]{0,300}?failed,/.test(src),
    "the response must carry the failed count, or a run that lost half the " +
      "cohort still records as a success",
  );
});

Deno.test("US-2314: the unique violation stays a no-op, not an error", () => {
  // A concurrent run inserting first is expected and must not be logged as a
  // failure — that was true before and must survive the reorder.
  assert(
    src.includes('logErr.code !== "23505"'),
    "23505 on the weekly log is 'already handled', not an error",
  );
});

// The property both fixes exist to preserve, modelled directly.
Deno.test("US-2314: a throwing user does not stop the cohort behind them", async () => {
  const celebrated: string[] = [];
  let failed = 0;
  const cohort = ["a", "b", "poison", "c", "d"];

  const send = (id: string) => {
    if (id === "poison") throw new Error("coordinator exploded");
    return Promise.resolve();
  };

  for (const id of cohort) {
    try {
      await send(id);
      // Written AFTER the send, so a throw leaves no "celebrated" record.
      celebrated.push(id);
    } catch {
      failed += 1;
    }
  }

  assertEquals(
    celebrated,
    ["a", "b", "c", "d"],
    "users after the throw still ran",
  );
  assertEquals(failed, 1);
  assert(
    !celebrated.includes("poison"),
    "the user who never got the email must NOT be marked celebrated — that is " +
      "what made the loss permanent once the week key moved on",
  );
});
