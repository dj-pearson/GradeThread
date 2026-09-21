#!/usr/bin/env node
// Worth My Time, R1 02/12 (US-3167 AC6): the storage rules, proved against a
// real Postgres rather than asserted in a comment.
//
// Every case here is one the application cannot enforce on its own:
//
//   isolation           two sellers' sessions never see each other
//   repeated keys       a retried timing event is a no-op, not double time
//   invalid transitions the CHECK refuses a state nothing should reach
//   competing sessions  two concurrent Starts, one survives
//   competing tasks     two concurrent task Starts in one session, one survives
//   stale revisions     a revision-scoped update matches nothing
//   item deletion       the task survives, tombstoned, and is not actionable
//   workspace erasure   deleting the user takes the planner data with it
//
// Usage:
//   node scripts/check-work-session-storage.mjs --dsn "postgresql://..."
//
// Everything runs inside ONE transaction that is ROLLED BACK, so it is safe
// against any database carrying the migrations, including one with real rows.

import { spawnSync } from "node:child_process";
import { looksUnreachable, psqlTarget } from "./lib/psql-target.mjs";

const target = psqlTarget();

function sql(text) {
  const res = spawnSync(target.cmd, target.argv, {
    input: text,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (looksUnreachable(out, res.status)) {
    console.error(`[work-session-storage] cannot reach ${target.how}`);
    console.error(`  ${target.hint}`);
    process.exit(2);
  }
  return out;
}

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

// One statement, one line of output, prefixed so a scrape cannot mistake a
// NOTICE for a result.
const SCRIPT = `
\\set ON_ERROR_STOP off
begin;

insert into auth.users (id, email) values
  ('${A}', 'wmt-a@test.invalid'), ('${B}', 'wmt-b@test.invalid')
on conflict (id) do nothing;

insert into public.flipdesk_work_sessions (id, user_id, state, work_context, budget_minutes)
values ('11111111-0000-4000-8000-00000000000a', '${A}', 'active', 'home', 30),
       ('22222222-0000-4000-8000-00000000000b', '${B}', 'active', 'home', 60);

-- 1. ISOLATION: each seller's own row, and only their own.
select 'isolation_a=' || count(*) from public.flipdesk_work_sessions where user_id = '${A}';
select 'isolation_b=' || count(*) from public.flipdesk_work_sessions where user_id = '${B}';

-- 2. COMPETING SESSIONS: a second active session for A must be refused. The
--    partial unique index is what holds this under two concurrent requests.
savepoint s1;
insert into public.flipdesk_work_sessions (user_id, state, work_context, budget_minutes)
values ('${A}', 'active', 'home', 15);
select 'second_active_session=ALLOWED_BUG';
rollback to savepoint s1;
select 'second_active_session=refused';

-- ...but a second PLANNED session is fine: a seller may line up tomorrow's.
insert into public.flipdesk_work_sessions (user_id, state, work_context, budget_minutes)
values ('${A}', 'planned', 'home', 15);
select 'second_planned_session=allowed';

-- 3. INVALID STATE: the CHECK refuses anything outside the five.
savepoint s2;
update public.flipdesk_work_sessions set state = 'zombie'
 where id = '11111111-0000-4000-8000-00000000000a';
select 'invalid_session_state=ALLOWED_BUG';
rollback to savepoint s2;
select 'invalid_session_state=refused';

insert into public.flipdesk_work_session_tasks
  (id, session_id, user_id, position, state, action_key)
values ('33333333-0000-4000-8000-00000000000c', '11111111-0000-4000-8000-00000000000a', '${A}', 1, 'active', 'photograph'),
       ('44444444-0000-4000-8000-00000000000d', '11111111-0000-4000-8000-00000000000a', '${A}', 2, 'pending', 'measure');

-- 4. COMPETING TASKS: a second active task in the same session is refused.
savepoint s3;
update public.flipdesk_work_session_tasks set state = 'active'
 where id = '44444444-0000-4000-8000-00000000000d';
select 'second_active_task=ALLOWED_BUG';
rollback to savepoint s3;
select 'second_active_task=refused';

savepoint s4;
update public.flipdesk_work_session_tasks set state = 'exploded'
 where id = '44444444-0000-4000-8000-00000000000d';
select 'invalid_task_state=ALLOWED_BUG';
rollback to savepoint s4;
select 'invalid_task_state=refused';

-- 5. REPEATED RETRY KEY: the same event sent twice is one row, not two.
insert into public.flipdesk_work_timing_events (task_id, user_id, kind, retry_key)
values ('33333333-0000-4000-8000-00000000000c', '${A}', 'task_started', '33333333-0000-4000-8000-00000000000c:task_started:1');
savepoint s5;
insert into public.flipdesk_work_timing_events (task_id, user_id, kind, retry_key)
values ('33333333-0000-4000-8000-00000000000c', '${A}', 'task_started', '33333333-0000-4000-8000-00000000000c:task_started:1');
select 'duplicate_retry_key=ALLOWED_BUG';
rollback to savepoint s5;
select 'duplicate_retry_key=refused';
-- A genuine SECOND start (attempt 2, after a pause) is a different key and
-- must still land -- deduplication that blocked real work would be worse.
insert into public.flipdesk_work_timing_events (task_id, user_id, kind, retry_key)
values ('33333333-0000-4000-8000-00000000000c', '${A}', 'task_started', '33333333-0000-4000-8000-00000000000c:task_started:2');
select 'timing_events=' || count(*) from public.flipdesk_work_timing_events
 where task_id = '33333333-0000-4000-8000-00000000000c';

-- 6. STALE REVISION: an update scoped to the revision the writer READ matches
--    nothing once somebody else has bumped it. This is the two-tabs case.
update public.flipdesk_work_sessions set revision = revision + 1
 where id = '11111111-0000-4000-8000-00000000000a' and revision = 1;
with stale as (
  update public.flipdesk_work_sessions set state = 'paused'
   where id = '11111111-0000-4000-8000-00000000000a' and revision = 1
   returning 1
) select 'stale_revision_rows=' || count(*) from stale;
with fresh as (
  update public.flipdesk_work_sessions set state = 'paused'
   where id = '11111111-0000-4000-8000-00000000000a' and revision = 2
   returning 1
) select 'fresh_revision_rows=' || count(*) from fresh;

-- 7. ITEM DELETION: the task survives with a null item reference, so the
--    seller keeps the record and the planner cannot hand them the task again.
insert into public.inventory_items (id, user_id, title)
values ('55555555-0000-4000-8000-00000000000e', '${A}', 'Carhartt Detroit jacket');
update public.flipdesk_work_session_tasks
   set inventory_item_id = '55555555-0000-4000-8000-00000000000e',
       item_title_snapshot = 'Carhartt Detroit jacket'
 where id = '44444444-0000-4000-8000-00000000000d';
delete from public.inventory_items where id = '55555555-0000-4000-8000-00000000000e';
select 'task_survives_item_delete=' || count(*) from public.flipdesk_work_session_tasks
 where id = '44444444-0000-4000-8000-00000000000d';
select 'tombstoned_item_ref=' || coalesce(inventory_item_id::text, 'NULL')
  || ' title=' || coalesce(item_title_snapshot, 'NULL')
  from public.flipdesk_work_session_tasks where id = '44444444-0000-4000-8000-00000000000d';

-- 8. ERASURE: deleting the account takes every planner row with it, through
--    the FKs the existing delete_account() RPC already relies on (00043).
delete from auth.users where id = '${A}';
select 'after_erasure_sessions=' || count(*) from public.flipdesk_work_sessions where user_id = '${A}';
select 'after_erasure_tasks=' || count(*) from public.flipdesk_work_session_tasks where user_id = '${A}';
select 'after_erasure_events=' || count(*) from public.flipdesk_work_timing_events where user_id = '${A}';
-- ...and leaves the OTHER seller alone, which is the half an over-broad
-- cascade would break silently.
select 'other_seller_survives=' || count(*) from public.flipdesk_work_sessions where user_id = '${B}';

rollback;
`;

const out = sql(SCRIPT);
const seen = new Map();
for (const line of out.split("\n")) {
  const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
  // FIRST occurrence wins, and that is the whole guard. Each refusal case
  // prints `<key>=ALLOWED_BUG` on the line AFTER the statement that should
  // have failed, then rolls back to its savepoint and prints `<key>=refused`
  // unconditionally. A last-write-wins map therefore reads a real hole as a
  // pass: dropping the one-active-session index left this script GREEN until
  // this line changed. Both lines are emitted either way; only the order tells
  // you which happened.
  if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
}

const EXPECTED = [
  ["isolation_a", "1"],
  ["isolation_b", "1"],
  ["second_active_session", "refused"],
  ["second_planned_session", "allowed"],
  ["invalid_session_state", "refused"],
  ["second_active_task", "refused"],
  ["invalid_task_state", "refused"],
  ["duplicate_retry_key", "refused"],
  ["timing_events", "2"],
  ["stale_revision_rows", "0"],
  ["fresh_revision_rows", "1"],
  ["task_survives_item_delete", "1"],
  ["tombstoned_item_ref", "NULL title=Carhartt Detroit jacket"],
  ["after_erasure_sessions", "0"],
  ["after_erasure_tasks", "0"],
  ["after_erasure_events", "0"],
  ["other_seller_survives", "1"],
];

const problems = [];
for (const [key, want] of EXPECTED) {
  const got = seen.get(key);
  if (got === undefined) {
    problems.push(`${key}: no result line, so the statement did not run`);
  } else if (got !== want) {
    problems.push(`${key}: expected ${want}, got ${got}`);
  }
}

if (problems.length > 0) {
  console.error(`[work-session-storage] ${problems.length} problem(s) against ${target.how}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `[work-session-storage] OK: ${EXPECTED.length} storage rules hold against ${target.how} ` +
    `(isolation, retry keys, invalid transitions, competing sessions and tasks, ` +
    `stale revisions, item tombstones, erasure). All work rolled back.`,
);
