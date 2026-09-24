#!/usr/bin/env node
// US-3182: what the database refuses, proved against a real Postgres.
//
// The shape CHECKs in 00820 are the half no application code can do: an
// override row with the wrong columns filled reads as valid to any JavaScript
// that only looks at `kind`, and a snooze with no expiry is a dismissal
// nobody asked for. These are the rules that have to hold under a bad caller,
// a future importer and a hand-written INSERT, so they are tested where they
// live.
//
// Everything runs inside ONE TRANSACTION THAT ROLLS BACK, so it can be run
// against any database with the migrations applied without leaving a row.
//
// Usage: node scripts/check-work-override-storage.mjs [--dsn postgres://...]

import { argv, exit, env } from "node:process";
import { execFileSync } from "node:child_process";
import { psqlTarget } from "./lib/psql-target.mjs";

// Same target rules as the other fixture scripts: --dsn wins, then
// SUPABASE_DB_URL, then the Supabase CLI's Docker container. The DB
// Migrations workflow passes nothing, so the container path is the one CI
// uses; before this, a bare run exited 2 with "need --dsn" and the step
// had never gone green there.
const cli = argv.slice(2);
const target = psqlTarget(
  !cli.includes("--dsn") && env.SUPABASE_DB_URL ? ["--dsn", env.SUPABASE_DB_URL] : cli,
);

function psql(text, stdio) {
  return execFileSync(target.cmd, [...target.argv, "-v", "ON_ERROR_STOP=1", "-c", text], {
    encoding: "utf8",
    ...(stdio ? { stdio } : {}),
  });
}

// Reach the database first. Every `refuses` case counts a psql failure as a
// pass, so an unreachable server would otherwise read as all rules holding.
try {
  psql("select 1", ["ignore", "pipe", "pipe"]);
} catch (e) {
  console.error(`[work-override-storage] cannot reach ${target.how}: ${String(e.stderr || e).trim().slice(0, 300)}`);
  console.error(`  ${target.hint}`);
  exit(2);
}

let passed = 0;
const failures = [];

function sql(text) {
  return psql(text).trim();
}

/** Run a statement expecting it to FAIL, and say why it should. */
function refuses(name, statement) {
  try {
    psql(`begin; ${statement}; rollback;`, ["ignore", "pipe", "pipe"]);
    failures.push(`${name} -- the database ACCEPTED a row it should refuse`);
    console.log(`  FAIL  ${name}`);
  } catch {
    passed += 1;
    console.log(`  ok    ${name}`);
  }
}

/** Run a statement expecting it to SUCCEED. */
function accepts(name, statement) {
  try {
    psql(`begin; ${statement}; rollback;`, ["ignore", "pipe", "pipe"]);
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(`${name} -- refused a row it should accept: ${String(e).slice(0, 200)}`);
    console.log(`  FAIL  ${name}`);
  }
}

// A seller and an item to hang the rows off. Created inside each transaction.
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data)
    values ('dddd0001-0000-0000-0000-000000000001', 'ovr@example.test', '{}'::jsonb)
    on conflict (id) do nothing;
  insert into public.users (id, email) values
    ('dddd0001-0000-0000-0000-000000000001', 'ovr@example.test')
    on conflict (id) do nothing;
  insert into public.inventory_items (id, user_id, title, status) values
    ('dddd0002-0000-0000-0000-000000000002','dddd0001-0000-0000-0000-000000000001','Test jacket','cataloged')
    on conflict (id) do nothing;
`;
const OWNER = "'dddd0001-0000-0000-0000-000000000001'";
const ITEM = "'dddd0002-0000-0000-0000-000000000002'";

function ins(cols, vals) {
  return `${SETUP} insert into public.flipdesk_work_overrides (owner_user_id, inventory_item_id, ${cols}) values (${OWNER}, ${ITEM}, ${vals})`;
}
function sup(cols, vals) {
  return `${SETUP} insert into public.flipdesk_work_suppressions (owner_user_id, inventory_item_id, ${cols}) values (${OWNER}, ${ITEM}, ${vals})`;
}

console.log("\noverride shape (00820)");
accepts("a minutes override with minutes is accepted",
  ins("kind, amount_minutes", "'task_minutes', 20"));
refuses("a minutes override with NO minutes is refused",
  ins("kind", "'task_minutes'"));
refuses("a minutes override of zero is refused",
  ins("kind, amount_minutes", "'task_minutes', 0"));
refuses("a minutes override carrying cents as well is refused",
  ins("kind, amount_minutes, amount_cents", "'task_minutes', 20, 100"));
accepts("a cost override of ZERO is accepted",
  ins("kind, amount_cents", "'remaining_cost', 0"));
refuses("a negative cost is refused",
  ins("kind, amount_cents", "'remaining_cost', -1"));
accepts("a value range low..high is accepted",
  ins("kind, low_cents, high_cents", "'value_range', 100, 900"));
refuses("an INVERTED value range is refused",
  ins("kind, low_cents, high_cents", "'value_range', 900, 100"));
refuses("a value range missing its high end is refused",
  ins("kind, low_cents", "'value_range', 100"));
refuses("an unknown kind is refused",
  ins("kind, amount_minutes", "'guesswork', 20"));

console.log("\none override per scope");
refuses("a second override of the same scope collides",
  `${ins("kind, amount_minutes", "'task_minutes', 20")};
   insert into public.flipdesk_work_overrides (owner_user_id, inventory_item_id, kind, amount_minutes)
     values (${OWNER}, ${ITEM}, 'task_minutes', 30)`);
accepts("the same item can carry a minutes AND a value override",
  `${ins("kind, amount_minutes", "'task_minutes', 20")};
   insert into public.flipdesk_work_overrides (owner_user_id, inventory_item_id, kind, low_cents, high_cents)
     values (${OWNER}, ${ITEM}, 'value_range', 100, 900)`);
accepts("two actions on one item each carry their own minutes",
  `${ins("kind, action_key, amount_minutes", "'task_minutes', 'photograph', 20")};
   insert into public.flipdesk_work_overrides (owner_user_id, inventory_item_id, kind, action_key, amount_minutes)
     values (${OWNER}, ${ITEM}, 'task_minutes', 'measure', 9)`);

console.log("\nsuppression shape (00820)");
accepts("a dismiss with no clock is accepted",
  sup("kind", "'dismiss'"));
refuses("a dismiss carrying an expiry is refused",
  sup("kind, until", "'dismiss', now() + interval '7 days'"));
accepts("a snooze with an expiry is accepted",
  sup("kind, until", "'snooze', now() + interval '7 days'"));
// THE ONE THAT MATTERS: a snooze with no end is a dismissal nobody asked for.
refuses("a snooze with NO expiry is refused",
  sup("kind", "'snooze'"));
refuses("a skip with no session is refused",
  sup("kind", "'skip_session'"));
refuses("a snooze carrying a session is refused",
  sup("kind, until, session_id", "'snooze', now(), '00000000-0000-0000-0000-000000000000'"));

console.log("\nownership and cascade");
refuses("an override for an item that does not exist is refused",
  `${SETUP} insert into public.flipdesk_work_overrides (owner_user_id, inventory_item_id, kind, amount_minutes)
     values (${OWNER}, '00000000-0000-0000-0000-0000000000ff', 'task_minutes', 20)`);
refuses("an override for an owner that does not exist is refused",
  `${SETUP} insert into public.flipdesk_work_overrides (owner_user_id, inventory_item_id, kind, amount_minutes)
     values ('00000000-0000-0000-0000-0000000000ff', ${ITEM}, 'task_minutes', 20)`);

console.log("\nprivileges");
for (const table of ["flipdesk_work_overrides", "flipdesk_work_suppressions"]) {
  const grants = sql(
    `select count(*) from information_schema.role_table_grants
      where table_name = '${table}' and grantee in ('anon','authenticated')`,
  );
  if (grants === "0") {
    passed += 1;
    console.log(`  ok    ${table} is service-role only`);
  } else {
    failures.push(`${table} has ${grants} grant(s) to anon/authenticated`);
    console.log(`  FAIL  ${table} is service-role only`);
  }
  const rls = sql(
    `select relrowsecurity from pg_class where relname = '${table}'`,
  );
  if (rls === "t") {
    passed += 1;
    console.log(`  ok    ${table} has RLS enabled`);
  } else {
    failures.push(`${table} does not have RLS enabled`);
    console.log(`  FAIL  ${table} has RLS enabled`);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  exit(1);
}
