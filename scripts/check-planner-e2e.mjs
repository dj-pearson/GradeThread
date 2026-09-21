#!/usr/bin/env node
// US-3177: the Worth My Time session, end to end, against a REAL edge service
// and a REAL database.
//
// WHY A SCRIPT AND NOT A DENO TEST. The planner's unit and route tests already
// run in `deno test`; what they cannot do is prove that the edge service, the
// migrations and PostgREST agree with each other. This exercises the running
// container over HTTP with two real sellers, the way the browser does.
//
// NOTHING HERE IS MOCKED BELOW THE HTTP BOUNDARY. The sessions, the tasks and
// the timing events are rows; the ownership checks are the real ones; the
// state machine is the real one. What IS stubbed, on a machine without the
// full Supabase stack, is GoTrue -- see scripts/lib/planner-e2e-README or the
// story note. That stub answers "who is this token", and nothing else.
//
// Usage:
//   node scripts/check-planner-e2e.mjs --base http://127.0.0.1:8787 \
//        --token-a alice-token --token-b mallory-token \
//        --user-a <uuid> --user-b <uuid> --dsn postgres://...

import { argv, exit } from "node:process";

function arg(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const BASE = arg("base", "http://127.0.0.1:8787");
const TOKEN_A = arg("token-a");
const TOKEN_B = arg("token-b");
const USER_A = arg("user-a");

if (!TOKEN_A || !TOKEN_B || !USER_A) {
  console.error("need --token-a, --token-b and --user-a");
  exit(2);
}

let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function call(token, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  // A 429 IS NOT A RESULT, IT IS A STOPPED RUN. Back-to-back runs trip the
  // edge's rate limiter, and letting that flow through produced a screenful of
  // unrelated failures ("preferences survive a fresh read", "it starts with
  // the three tasks") that read exactly like the feature being broken. The
  // limiter working is not a finding; being unable to tell is.
  if (res.status === 429) {
    console.error(
      `\nSTOPPED: the edge rate-limited this run (429 on ${path}).\n` +
      "That is the limiter working, not a failure of the planner. Wait for " +
      "the window to clear and run again.",
    );
    exit(3);
  }
  return { status: res.status, json };
}

function section(title) {
  console.log(`\n${title}`);
}

const ITEMS = {
  jacket: "aaaa0001-0000-0000-0000-000000000001",
  fleece: "aaaa0002-0000-0000-0000-000000000002",
  jeans: "aaaa0003-0000-0000-0000-000000000003",
  synchilla: "aaaa0004-0000-0000-0000-000000000004",
  sold: "aaaa0005-0000-0000-0000-000000000005",
  mallorys: "bbbb0001-0000-0000-0000-000000000001",
};

function planTask(over) {
  return {
    inventory_item_id: ITEMS.jacket,
    item_title: "Carhartt Detroit jacket",
    action_key: "measure",
    prerequisite_keys: [],
    bin: "A-14",
    estimate_minutes: 5,
    estimate_value_cents: 4800,
    estimate_source: "valued_work",
    ...over,
  };
}

async function clearSessions() {
  // Leave no open session behind, for either seller.
  //
  // WRITTEN AS A LOOP WITH FRESH READS because the first version was a single
  // best-effort call and the script passed on the first run and crashed on the
  // second. A harness that only works from a clean database is not a harness;
  // it is a demo. Each pass re-reads the session so the revision is current,
  // and tries both terminal moves, because `planned` can only be abandoned
  // while `active` and `paused` can be completed.
  for (const token of [TOKEN_A, TOKEN_B]) {
    for (let pass = 0; pass < 5; pass += 1) {
      const cur = await call(token, "/api/flipdesk/planner/sessions/current");
      const s = cur.json?.session;
      if (!s || ["completed", "abandoned"].includes(s.state)) break;
      let cleared = false;
      for (const action of ["complete", "abandon"]) {
        const res = await call(token, `/api/flipdesk/planner/sessions/${s.id}/${action}`, {
          method: "POST",
          body: JSON.stringify({ revision: s.revision }),
        });
        if (res.status === 200) { cleared = true; break; }
      }
      if (!cleared) {
        console.error(
          `could not clear a ${s.state} session (${s.id}); the run would not be repeatable`,
        );
        exit(2);
      }
    }
    const after = await call(token, "/api/flipdesk/planner/sessions/current");
    if (after.json?.session && !["completed", "abandoned"].includes(after.json.session.state)) {
      console.error(`a session survived cleanup: ${JSON.stringify(after.json.session)}`);
      exit(2);
    }
  }
}

async function main() {
  console.log(`planner e2e against ${BASE}`);
  await clearSessions();

  // ── preferences ────────────────────────────────────────────────
  section("preferences (AC1)");
  const prefsBefore = await call(TOKEN_A, "/api/flipdesk/work-preferences");
  check("GET preferences answers", prefsBefore.status === 200, `status ${prefsBefore.status}`);

  const saved = await call(TOKEN_A, "/api/flipdesk/work-preferences", {
    method: "PATCH",
    body: JSON.stringify({
      default_session_minutes: 30,
      work_context: "home",
      available_tools: ["camera", "measuring_tape"],
    }),
  });
  check("PATCH preferences persists", saved.status === 200 &&
    saved.json.default_session_minutes === 30, JSON.stringify(saved.json).slice(0, 120));

  const prefsAfter = await call(TOKEN_A, "/api/flipdesk/work-preferences");
  check("preferences survive a fresh read",
    prefsAfter.json.work_context === "home" &&
    prefsAfter.json.available_tools.includes("measuring_tape"));

  // An unsupported currency must be refused rather than stored (AC2).
  const badCurrency = await call(TOKEN_A, "/api/flipdesk/work-preferences", {
    method: "PATCH",
    body: JSON.stringify({ hourly_target_amount: 20, hourly_target_currency: "XYZ" }),
  });
  check("an unsupported currency is refused, not stored",
    badCurrency.status >= 400, `status ${badCurrency.status}`);

  // ── start a session ────────────────────────────────────────────
  section("a session (AC1)");
  const created = await call(TOKEN_A, "/api/flipdesk/planner/sessions", {
    method: "POST",
    body: JSON.stringify({
      budget_minutes: 30,
      work_context: "home",
      available_tools: ["camera", "measuring_tape"],
      tasks: [
        planTask({}),
        planTask({
          inventory_item_id: ITEMS.jeans,
          item_title: "Levi 501 jeans",
          bin: null,
          estimate_minutes: 5,
        }),
        planTask({
          inventory_item_id: ITEMS.synchilla,
          item_title: "Patagonia Synchilla",
          action_key: "photograph",
          bin: "B-02",
          estimate_minutes: 8,
        }),
      ],
    }),
  });
  check("POST /sessions creates one", created.status === 201 && !!created.json.session?.id,
    JSON.stringify(created.json).slice(0, 160));
  const sessionId = created.json.session?.id;
  let revision = created.json.session?.revision;
  check("it starts with the three tasks in plan order",
    created.json.tasks?.length === 3 &&
    created.json.tasks[0].position < created.json.tasks[1].position);
  check("a task with no bin keeps its null rather than inventing one",
    created.json.tasks?.[1]?.bin === null, JSON.stringify(created.json.tasks?.[1]?.bin));

  // ── one at a time ──────────────────────────────────────────────
  const second = await call(TOKEN_A, "/api/flipdesk/planner/sessions", {
    method: "POST",
    body: JSON.stringify({
      budget_minutes: 30,
      work_context: "home",
      available_tools: ["camera"],
      tasks: [planTask({})],
    }),
  });
  // ASSERTED ON THE REASON, not merely on "it failed". The first version of
  // this check sent a body with no work_context and passed on the resulting
  // validation 400, which proved nothing about the uniqueness rule it is
  // named for.
  check("a second open session is refused (00818's partial unique index)",
    second.status === 409, `status ${second.status} ${JSON.stringify(second.json).slice(0, 100)}`);

  // ── restore ────────────────────────────────────────────────────
  const current = await call(TOKEN_A, "/api/flipdesk/planner/sessions/current");
  check("GET current returns the same session (this is what a reload does)",
    current.json.session?.id === sessionId);

  // ── work a task ────────────────────────────────────────────────
  section("working a task (AC1, AC3)");
  const taskId = created.json.tasks[0].id;
  const started = await call(TOKEN_A, `/api/flipdesk/planner/tasks/${taskId}/start`, {
    method: "POST",
    body: JSON.stringify({ revision, attempt: 1 }),
  });
  check("start moves it to active", started.status === 200 &&
    started.json.tasks.find((t) => t.id === taskId)?.state === "active");
  revision = started.json.session.revision;

  // A REPEATED START WITH THE SAME ATTEMPT must not record a second event.
  const restart = await call(TOKEN_A, `/api/flipdesk/planner/tasks/${taskId}/start`, {
    method: "POST",
    body: JSON.stringify({ revision, attempt: 1 }),
  });
  check("starting an already-active task is refused, not double-counted",
    restart.status === 409, `status ${restart.status}`);

  const completed = await call(TOKEN_A, `/api/flipdesk/planner/tasks/${taskId}/complete`, {
    method: "POST",
    body: JSON.stringify({ revision, confirmed_minutes: 12 }),
  });
  check("complete records the seller's minutes, not a clock reading",
    completed.status === 200 &&
    completed.json.tasks.find((t) => t.id === taskId)?.confirmed_minutes === 12,
    JSON.stringify(completed.json).slice(0, 200));
  revision = completed.json.session.revision;

  const recomplete = await call(TOKEN_A, `/api/flipdesk/planner/tasks/${taskId}/complete`, {
    method: "POST",
    body: JSON.stringify({ revision, confirmed_minutes: 99 }),
  });
  check("a completed task cannot be completed again (ONE completion)",
    recomplete.status === 409, `status ${recomplete.status}`);
  const stillTwelve = await call(TOKEN_A, "/api/flipdesk/planner/sessions/current");
  check("and the retry did not overwrite the minutes",
    stillTwelve.json.tasks.find((t) => t.id === taskId)?.confirmed_minutes === 12);

  // ── two tabs ───────────────────────────────────────────────────
  section("two tabs (AC3)");
  const staleRevision = revision - 5;
  const task2 = created.json.tasks[1].id;
  const conflict = await call(TOKEN_A, `/api/flipdesk/planner/tasks/${task2}/start`, {
    method: "POST",
    body: JSON.stringify({ revision: staleRevision, attempt: 1 }),
  });
  check("a stale revision is refused with 409", conflict.status === 409);
  check("and the refusal carries the true session, so no replay is needed",
    !!conflict.json.session?.id && Array.isArray(conflict.json.tasks),
    JSON.stringify(conflict.json).slice(0, 120));
  check("the refused action did not happen",
    conflict.json.tasks.find((t) => t.id === task2)?.state === "pending");

  // ── pause and resume ───────────────────────────────────────────
  section("an interruption (AC1)");
  const cur2 = await call(TOKEN_A, "/api/flipdesk/planner/sessions/current");
  revision = cur2.json.session.revision;
  const started2 = await call(TOKEN_A, `/api/flipdesk/planner/tasks/${task2}/start`, {
    method: "POST",
    body: JSON.stringify({ revision, attempt: 1 }),
  });
  revision = started2.json.session.revision;
  const paused = await call(TOKEN_A, `/api/flipdesk/planner/sessions/${sessionId}/pause`, {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
  check("pause moves the session, not the task to skipped",
    paused.status === 200 && paused.json.session.state === "paused" &&
    paused.json.tasks.find((t) => t.id === task2)?.state !== "skipped");
  revision = paused.json.session.revision;

  const afterReload = await call(TOKEN_A, "/api/flipdesk/planner/sessions/current");
  check("a reload finds it still paused, with its progress",
    afterReload.json.session.state === "paused" &&
    afterReload.json.tasks.find((t) => t.id === taskId)?.state === "completed");

  const resumed = await call(TOKEN_A, `/api/flipdesk/planner/sessions/${sessionId}/resume`, {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
  check("resume brings it back", resumed.status === 200 &&
    resumed.json.session.state === "active");
  revision = resumed.json.session.revision;

  // ── skip and finish ────────────────────────────────────────────
  section("skipping and finishing (AC1, AC5)");
  const task3 = created.json.tasks[2].id;
  const skipped = await call(TOKEN_A, `/api/flipdesk/planner/tasks/${task3}/skip`, {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
  check("skip is recorded as a choice, distinct from invalidated",
    skipped.status === 200 &&
    skipped.json.tasks.find((t) => t.id === task3)?.state === "skipped");
  revision = skipped.json.session.revision;

  const finished = await call(TOKEN_A, `/api/flipdesk/planner/sessions/${sessionId}/complete`, {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
  check("finish completes the session", finished.status === 200 &&
    finished.json.session.state === "completed");
  check("and releases the running task to pending rather than skipping it",
    finished.json.tasks.find((t) => t.id === task2)?.state === "pending",
    finished.json.tasks.find((t) => t.id === task2)?.state);
  check("the confirmed minutes survive the finish",
    finished.json.tasks.find((t) => t.id === taskId)?.confirmed_minutes === 12);

  const reopened = await call(TOKEN_A, `/api/flipdesk/planner/sessions/${sessionId}/resume`, {
    method: "POST",
    body: JSON.stringify({ revision: finished.json.session.revision }),
  });
  check("a completed session cannot be reopened", reopened.status === 409);

  // ── tenant isolation ───────────────────────────────────────────
  section("a second seller (AC2, US-268)");
  const mallorySees = await call(TOKEN_B, "/api/flipdesk/planner/sessions/current");
  check("the other seller does not see Alice's session",
    mallorySees.json.session === null ||
    mallorySees.json.session?.id !== sessionId,
    JSON.stringify(mallorySees.json).slice(0, 120));

  const steal = await call(TOKEN_B, `/api/flipdesk/planner/tasks/${taskId}/start`, {
    method: "POST",
    body: JSON.stringify({ revision: 1, attempt: 1 }),
  });
  check("the other seller cannot act on Alice's task", steal.status === 404,
    `status ${steal.status}`);

  const stealSession = await call(TOKEN_B, `/api/flipdesk/planner/sessions/${sessionId}/pause`, {
    method: "POST",
    body: JSON.stringify({ revision: 1 }),
  });
  check("nor on her session", stealSession.status === 404, `status ${stealSession.status}`);

  const foreignItem = await call(TOKEN_A, "/api/flipdesk/planner/sessions", {
    method: "POST",
    body: JSON.stringify({
      budget_minutes: 30,
      work_context: "home",
      available_tools: ["camera"],
      tasks: [planTask({
        inventory_item_id: ITEMS.mallorys,
        item_title: "MALLORY SECRET COAT",
      })],
    }),
  });
  // THE ROUTE DROPS THE FOREIGN TASK RATHER THAN REFUSING THE WHOLE PLAN, and
  // reports which ids it dropped. That is the designed behaviour and it is the
  // right one: a plan is built client-side over rows the seller could see, so
  // an unowned id is a bug or a probe rather than something worth losing the
  // other nineteen tasks over. What matters for US-268 is that the item does
  // not end up IN the session, and that nothing about it comes back.
  // A PLAN OF NOTHING BUT UNOWNED ITEMS IS REFUSED OUTRIGHT. The earlier
  // behaviour kept the task with a null item id, which left a row in the
  // seller's session carrying a caller-chosen title and looking exactly like
  // "your item was deleted".
  check("a plan of another seller's items is refused",
    foreignItem.status === 400 && foreignItem.json.code === "no_owned_tasks",
    `status ${foreignItem.status} ${JSON.stringify(foreignItem.json).slice(0, 120)}`);
  check("no task row is created for it",
    !Array.isArray(foreignItem.json.tasks),
    JSON.stringify(foreignItem.json.tasks ?? []).slice(0, 120));
  check("and the response names the dropped id rather than shrinking silently",
    (foreignItem.json.dropped_item_ids ?? []).includes(ITEMS.mallorys),
    JSON.stringify(foreignItem.json.dropped_item_ids));
  check("and nothing of the other seller's row is echoed back",
    !JSON.stringify(foreignItem.json).includes("MALLORY SECRET COAT"),
    JSON.stringify(foreignItem.json).slice(0, 160));

  // The refused plan must not have left a session behind, or the next create
  // trips the one-open-session guard.
  const afterRefusal = await call(TOKEN_A, "/api/flipdesk/planner/sessions/current");
  check("a refused plan leaves no open session behind",
    afterRefusal.json.session === null,
    JSON.stringify(afterRefusal.json.session ?? {}).slice(0, 120));

  // A MIXED plan keeps the owned half and says what it dropped.
  const mixed = await call(TOKEN_A, "/api/flipdesk/planner/sessions", {
    method: "POST",
    body: JSON.stringify({
      budget_minutes: 30,
      work_context: "home",
      available_tools: ["camera"],
      tasks: [
        planTask({}),
        planTask({ inventory_item_id: ITEMS.mallorys, item_title: "MALLORY SECRET COAT" }),
      ],
    }),
  });
  check("a mixed plan keeps the owned task", mixed.status === 201 &&
    mixed.json.tasks?.length === 1 &&
    mixed.json.tasks[0].inventory_item_id === ITEMS.jacket,
    JSON.stringify(mixed.json.tasks ?? []).slice(0, 160));
  check("and drops the unowned one entirely, not as a null-item row",
    !(mixed.json.tasks ?? []).some((t) => t.inventory_item_id === null));
  check("and reports which id it dropped",
    (mixed.json.dropped_item_ids ?? []).includes(ITEMS.mallorys));

  if (mixed.json.session?.id) {
    await call(TOKEN_A, `/api/flipdesk/planner/sessions/${mixed.json.session.id}/abandon`, {
      method: "POST",
      body: JSON.stringify({ revision: mixed.json.session.revision }),
    });
  }

  // ── the world moves under the seller ───────────────────────────
  section("a sold and a deleted item (AC2)");
  const soldPlan = await call(TOKEN_A, "/api/flipdesk/planner/sessions", {
    method: "POST",
    body: JSON.stringify({
      budget_minutes: 30,
      work_context: "home",
      available_tools: ["camera"],
      tasks: [
        planTask({ inventory_item_id: ITEMS.fleece, item_title: "Unbranded fleece" }),
        planTask({ inventory_item_id: ITEMS.sold, item_title: "Sold Nike windbreaker" }),
      ],
    }),
  });
  check("a plan can be built over a sold item (the row is still the seller's)",
    soldPlan.status === 201, `status ${soldPlan.status}`);
  const soldSessionId = soldPlan.json.session?.id;
  let rev2 = soldPlan.json.session?.revision;
  const soldTask = soldPlan.json.tasks?.find(
    (t) => t.inventory_item_id === ITEMS.sold,
  );
  const liveTask = soldPlan.json.tasks?.find(
    (t) => t.inventory_item_id === ITEMS.fleece,
  );

  const startSold = await call(TOKEN_A, `/api/flipdesk/planner/tasks/${soldTask.id}/start`, {
    method: "POST",
    body: JSON.stringify({ revision: rev2, attempt: 1 }),
  });
  // STARTING IT IS WHERE THE WORLD IS RE-READ. Prep work on something already
  // sold is not work, and the row is closed rather than handed over.
  check("starting prep on a sold item is refused with a reason",
    startSold.status === 409 && startSold.json.code === "task_invalidated",
    `status ${startSold.status} code ${startSold.json.code}`);
  check("and the refusal carries the session so nothing is replayed",
    Array.isArray(startSold.json.tasks));
  check("the task is closed, not left pending to be offered again",
    startSold.json.tasks?.find((t) => t.id === soldTask.id)?.state === "invalidated");
  check("NO LOST PROGRESS: the other task is untouched",
    startSold.json.tasks?.find((t) => t.id === liveTask.id)?.state === "pending");

  const afterInvalidate = await call(TOKEN_A, "/api/flipdesk/planner/sessions/current");
  rev2 = afterInvalidate.json.session.revision;
  const startLive = await call(TOKEN_A, `/api/flipdesk/planner/tasks/${liveTask.id}/start`, {
    method: "POST",
    body: JSON.stringify({ revision: rev2, attempt: 1 }),
  });
  check("the seller carries on with the rest of the plan", startLive.status === 200 &&
    startLive.json.tasks.find((t) => t.id === liveTask.id)?.state === "active");
  rev2 = startLive.json.session.revision;

  await call(TOKEN_A, `/api/flipdesk/planner/sessions/${soldSessionId}/complete`, {
    method: "POST",
    body: JSON.stringify({ revision: rev2 }),
  });

  // ── unauthenticated ────────────────────────────────────────────
  section("no token at all");
  const anon = await fetch(`${BASE}/api/flipdesk/planner/sessions/current`);
  check("an unauthenticated read is refused", anon.status === 401,
    `status ${anon.status}`);

  // Tidy up after ourselves as well as before. Clearing only at the start
  // leaves the database dirty for anything else looking at it between runs.
  await clearSessions();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
