// Worth My Time, R1 09/12 (US-3174): the planner router's rules.
//
// Run alone:
//   deno test --allow-net --allow-env --allow-read src/tests/flipdesk-planner_test.ts
//
// WHAT IS DRIVEN HERE AND WHAT IS NOT. The pure validation and the transition
// rules are called directly. The database half -- two sellers, stale
// revisions, a repeated request -- is proved by the STORAGE check against a
// real Postgres (scripts/check-work-session-storage.mjs, US-3167) and by the
// tenant-isolation suite against a running edge, because a stub cannot tell a
// check-then-write from an atomic one and neither can a mocked client.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  MAX_PLAN_TASKS,
  MAX_BUDGET_MINUTES,
  MIN_BUDGET_MINUTES,
  parsePlanTasks,
} from "../routes/flipdesk-planner.ts";
import {
  canTransitionSession,
  canTransitionTask,
  checkRevision,
  timingRetryKey,
} from "../lib/work-sessions.ts";

// ── Plan validation (AC6) ───────────────────────────────────────────

Deno.test("a plan needs at least one task", () => {
  const r = parsePlanTasks([]);
  assert(!r.ok);
  assert(r.error.includes("at least one"));
});

Deno.test("a plan is REFUSED above the cap, never truncated", () => {
  // A 240-minute session cannot hold 50 tasks at any believable estimate, so
  // a body claiming to is a bug or a probe. A silently shortened plan is one
  // the seller cannot reconcile with what they saw on screen.
  const many = Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => ({
    action_key: "measure",
    inventory_item_id: `item-${i}`,
  }));
  const r = parsePlanTasks(many);
  assert(!r.ok);
  assert(r.error.includes(String(MAX_PLAN_TASKS)));
  assert(r.error.includes(String(MAX_PLAN_TASKS + 1)));
});

Deno.test("exactly the cap is accepted", () => {
  const exact = Array.from({ length: MAX_PLAN_TASKS }, () => ({ action_key: "measure" }));
  const r = parsePlanTasks(exact);
  assert(r.ok);
  assertEquals(r.tasks.length, MAX_PLAN_TASKS);
});

Deno.test("a task with no action is refused, and says which one", () => {
  const r = parsePlanTasks([{ action_key: "measure" }, { inventory_item_id: "x" }]);
  assert(!r.ok);
  assert(r.error.includes("Task 2"));
});

Deno.test("a body that is not a list is refused rather than coerced", () => {
  for (const bad of [null, undefined, "measure", 42, { action_key: "measure" }]) {
    assert(!parsePlanTasks(bad).ok, `${String(bad)} should be refused`);
  }
});

Deno.test("estimates are snapshots and a bad one is dropped, not invented", () => {
  // The estimates are the record of what the plan was BUILT on and decide
  // nothing here. A negative or nonfinite one becomes null rather than a
  // plausible number the seller would later read as a fact.
  const r = parsePlanTasks([{
    action_key: "measure",
    estimate_minutes: -5,
    estimate_value_cents: Number.NaN,
    estimate_source: "  ",
  }]);
  assert(r.ok);
  assertEquals(r.tasks[0]!.estimateMinutes, null);
  assertEquals(r.tasks[0]!.estimateValueCents, null);
  assertEquals(r.tasks[0]!.estimateSource, null);
});

Deno.test("prerequisite keys survive, and non-strings are dropped", () => {
  const r = parsePlanTasks([{
    action_key: "draft_review",
    prerequisite_keys: ["x:photograph", 42, null, "x:measure"],
  }]);
  assert(r.ok);
  assertEquals(r.tasks[0]!.prerequisiteKeys, ["x:photograph", "x:measure"]);
});

Deno.test("the title is snapshotted, so history survives the garment", () => {
  const r = parsePlanTasks([{
    action_key: "measure",
    inventory_item_id: "item-1",
    item_title: "Carhartt Detroit jacket",
  }]);
  assert(r.ok);
  assertEquals(r.tasks[0]!.itemTitle, "Carhartt Detroit jacket");
});

// ── The lifecycle the router drives (AC6) ───────────────────────────

Deno.test("the full session lifecycle is legal, in order", () => {
  assert(canTransitionSession("planned", "active").ok);
  assert(canTransitionSession("active", "paused").ok);
  assert(canTransitionSession("paused", "active").ok);
  assert(canTransitionSession("active", "completed").ok);
});

Deno.test("a repeated lifecycle request is refused as a no-op", () => {
  // Two taps on Start. The second must not write a second timing event.
  const r = canTransitionSession("active", "active");
  assert(!r.ok);
  assertEquals(r.refusal.code, "no_change");
});

Deno.test("a repeated task action produces the SAME retry key", () => {
  // Which is what makes the upsert a no-op rather than double-counted time.
  assertEquals(
    timingRetryKey("task-1", "task_started", 1),
    timingRetryKey("task-1", "task_started", 1),
  );
  // ...and a genuine second start after a pause is attempt 2, a real event.
  assert(
    timingRetryKey("task-1", "task_started", 1) !==
      timingRetryKey("task-1", "task_started", 2),
  );
});

Deno.test("a stale revision is refused and carries both numbers", () => {
  const r = checkRevision(3, 5);
  assert(!r.ok);
  assertEquals(r.refusal.expected, 3);
  assertEquals(r.refusal.actual, 5);
});

Deno.test("a MISSING revision is refused, not treated as fresh", () => {
  // The dangerous default: a client that forgot to send one would otherwise
  // win every race.
  for (const bad of [undefined, null, "3", 3.5]) {
    assert(!checkRevision(bad, 3).ok, `${String(bad)} must be refused`);
  }
});

Deno.test("an invalidated task cannot be completed afterwards", () => {
  // The stock-changed-after-planning path ends here: once the route
  // invalidates a task, no later request can revive it.
  assert(!canTransitionTask("invalidated", "completed").ok);
  assert(!canTransitionTask("invalidated", "active").ok);
});

// ── The route's own guarantees, read from its source ────────────────

function routeSource(): string {
  return Deno.readTextFileSync(
    new URL("../routes/flipdesk-planner.ts", import.meta.url),
  );
}

function routeCode(): string {
  return routeSource()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

Deno.test("AC5: completing a timer publishes, ships and reprices NOTHING", () => {
  // The claim is about what the router does not do, so the check is a scan.
  // A planner that shipped a parcel because a timer ended would be acting on
  // the seller's behalf with no confirmation and no failure path.
  const code = routeCode();
  for (
    const banned of [
      "publishOffer",
      "createShippingFulfillment",
      "crossPushPlatform",
      "buyEasyPostShipment",
      "reprice",
      "grade_value",
      "listing_status",
    ]
  ) {
    assert(
      !code.includes(banned),
      `flipdesk-planner.ts touches ${banned}: completing a task must change no source system`,
    );
  }
});

Deno.test("AC3: every read and write is scoped on the owner", () => {
  // The service-role client bypasses RLS, so a query without the predicate is
  // a cross-tenant read waiting to happen. Every supabaseAdmin call in this
  // file must carry an owner predicate within a few lines of it.
  const code = routeCode();
  const calls = [...code.matchAll(/supabaseAdmin\s*\n?\s*\.from\("([a-z_]+)"\)/g)];
  assert(calls.length >= 8, `expected several queries, found ${calls.length}`);
  for (const call of calls) {
    const window = code.slice(call.index!, call.index! + 600);
    assert(
      window.includes('.eq("user_id"') || window.includes("user_id:"),
      `a ${call[1]} query has no owner predicate near it`,
    );
  }
});

Deno.test("AC4: a revision-scoped write puts the revision in the PREDICATE", () => {
  // A check followed by an unguarded write is two tabs both passing the check
  // and the second one winning silently.
  //
  // COUNTED, NOT MERELY PRESENT. The first version asserted the string existed
  // somewhere in the file, and a sabotage that removed it from the session
  // write passed, because bumpRevision carries the same line. Both sites need
  // it and both are named.
  const code = routeCode();
  const occurrences = [...code.matchAll(/\.eq\("revision", session\.revision\)/g)];
  assertEquals(
    occurrences.length,
    2,
    "both the session write and bumpRevision must scope on the revision they read",
  );
  const sessionWrite = code.slice(
    code.indexOf('.from("flipdesk_work_sessions")\n    .update(patch)'),
  ).slice(0, 400);
  assert(
    sessionWrite.includes('.eq("revision", session.revision)'),
    "the session lifecycle write lost its revision predicate",
  );
});

Deno.test("AC4: the staleness re-read happens on COMPLETE as well as START", () => {
  // A session can sit paused for an hour between the two, and the jacket can
  // sell on a phone while it does. Re-reading only on start was a sabotage
  // that passed, because nothing named the second half of the rule.
  const code = routeCode();
  assert(
    code.includes('if (action === "start" || action === "complete")'),
    "the item re-read must cover both start and complete",
  );
  assert(code.includes("itemStillWorkable("), "there must BE a re-read");
});

Deno.test("US-2351: abandoning a session is refused while impersonating", () => {
  // An admin acting as a customer may not throw away that customer's evening.
  // The other four lifecycle actions are recoverable; abandoning is not.
  // Nothing else caught this: the impersonation registry does not know about
  // this route, so a sabotage that deleted the guard passed everywhere.
  const code = routeCode();
  assert(
    code.includes('refuseWhileImpersonating(c, "abandon a work session")'),
    "the abandon path must call refuseWhileImpersonating",
  );
  const abandonGuard = code.indexOf('if (action === "abandon")');
  assert(abandonGuard > -1, "the guard must be keyed on the abandon action");
  assert(
    code.slice(abandonGuard, abandonGuard + 300).includes("refuseWhileImpersonating"),
    "the guard must sit inside the abandon branch",
  );
});

Deno.test("AC2: item ownership is one bounded query, never a per-item loop", () => {
  const code = routeCode();
  assert(code.includes('.in("id", itemIds)'), "ownership must be checked with .in()");
  // A loop issuing one request per item is what AC2 forbids.
  assert(!/for \([^)]*\)\s*\{[^}]*supabaseAdmin/.test(code));
});

Deno.test("AC2: list reads use explicit projections, never select(*)", () => {
  // Pulling every description, comp blob and photo into a list read is how a
  // plan for forty items becomes a megabyte.
  const code = routeCode();
  assert(!code.includes('select("*")'));
  assert(!code.includes(".select()"));
});

Deno.test("AC1: no background queue and no model call", () => {
  const code = routeCode();
  for (const banned of ["extension_work_queue", "anthropic", "messages.create", "enqueue"]) {
    assert(!code.includes(banned), `flipdesk-planner.ts uses ${banned}`);
  }
});

Deno.test("the budget window matches the preferences from R1 01/12", () => {
  assertEquals(MIN_BUDGET_MINUTES, 5);
  assertEquals(MAX_BUDGET_MINUTES, 240);
});

// ── US-3177: what the end-to-end run found ──────────────────────────

Deno.test("US-3177: starting a task starts the session", () => {
  // THE BUG THIS EXISTS FOR, found only by running the real thing. A session
  // is created `planned`, and the state machine allows `planned -> active`
  // but not `planned -> paused`. The client never sent a session `start`, so
  // a seller who began working still had a PLANNED session, and the first
  // Pause came back "a session can't go from planned to paused" -- a refusal
  // about an internal state they had never seen and could do nothing about.
  //
  // Every route test above set the session up in whatever state it wanted, so
  // none of them could see it. The end-to-end script is what caught it, and
  // this is what stops it coming back.
  const code = routeCode();
  const start = code.indexOf('if (action === "start" && session.state === "planned")');
  assert(start > 0, "the planned -> active promotion is gone");
  const block = code.slice(start, start + 600);
  assert(block.includes('state: "active"'), "the promotion must set active");
  assert(
    block.includes('.eq("state", "planned")'),
    "the promotion must be scoped to planned, so a race cannot resurrect a " +
      "paused or completed session",
  );
  assert(block.includes('.eq("user_id", ownerId)'), "US-268: and to the owner");
});

Deno.test("US-3177: the task response re-reads the session it may have moved", () => {
  // The second half of the same bug. The handler used to answer
  // `{ ...session, revision: nextRevision }` from the row it loaded BEFORE
  // the promotion, so a client that had just started work was told the
  // session was still `planned` -- and went on offering a Pause the server
  // would refuse. Patching a stale row is the whole failure mode.
  const code = routeCode();
  const tail = code.slice(code.lastIndexOf("await bumpRevision(session);"));
  assert(
    !tail.includes("{ ...session, revision: nextRevision }"),
    "the task response is patching a stale session row again",
  );
  assert(
    tail.includes("await loadOwnedSession(ownerId, session.id)"),
    "the task response must re-read the session before answering",
  );
});

Deno.test("US-3177: the create guard and the current read share ONE state list", () => {
  // THE BUG: the guard checked `active` alone while GET /sessions/current read
  // planned, active and paused. A seller could pause a session, build a second
  // plan, and have the first drop off the screen while staying open in the
  // database -- two sessions, one of them unreachable, and no error anywhere.
  //
  // Asserted as one shared constant rather than as two matching literals,
  // because two matching literals are what it was.
  const code = routeCode();
  assert(
    code.includes('const OPEN_SESSION_STATES = ["planned", "active", "paused"]'),
    "the shared open-state list is gone",
  );
  const uses = [...code.matchAll(/\.in\("state", OPEN_SESSION_STATES\)/g)];
  assertEquals(
    uses.length,
    2,
    "both the create guard and the current read must use the shared list",
  );
  assert(
    !/\.in\("state", \["planned"/.test(code),
    "a literal state list is back beside the shared one",
  );
});

Deno.test("US-3177: an unowned item drops its whole task, id and title", () => {
  // The earlier code nulled `inventory_item_id` and kept the row, so a session
  // ended up holding a task with a CALLER-CHOSEN title pointing at nothing.
  // Nothing leaked -- the title was the caller's own string -- but a null id
  // is how a DELETED item is recorded (the FK is ON DELETE SET NULL), so it
  // manufactured a "your item was deleted" row for an item that was never
  // theirs. Two different facts sharing one representation.
  const code = routeCode();
  assert(code.includes("const keptTasks = parsed.tasks.filter("),
    "unowned tasks are no longer filtered out");
  assert(
    !code.includes("inventory_item_id: t.inventoryItemId && ownedIds.has(t.inventoryItemId)"),
    "the null-the-id-and-keep-the-row behaviour is back",
  );
  // A plan of nothing but unowned items must not leave a session behind.
  assert(code.includes('code: "no_owned_tasks"'), "the all-unowned refusal is gone");
  const refusal = code.slice(code.indexOf("if (keptTasks.length === 0)"), code.indexOf("const rows = keptTasks"));
  assert(
    refusal.includes('state: "abandoned"'),
    "a refused plan must close the session row it already created",
  );
  assert(refusal.includes('.eq("user_id", ownerId)'), "US-268: and scope that close");
});
