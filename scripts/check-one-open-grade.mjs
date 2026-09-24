#!/usr/bin/env node
// US-3214: what the database refuses, proved against a real Postgres.
//
// 00821's partial unique index is the half no application code can do. The
// read in lib/grading-submit.ts refuses a second submission it can SEE, and
// two clicks landing in two isolates both see nothing -- so the rule that
// actually holds under concurrency is this index, and it is tested where it
// lives.
//
// Everything runs inside ONE TRANSACTION THAT ROLLS BACK, so it can be run
// against any database with the migrations applied without leaving a row.
//
// Usage: node scripts/check-one-open-grade.mjs [--dsn postgres://...]

import { argv, exit, env } from "node:process";
import { execFileSync } from "node:child_process";
import { psqlTarget } from "./lib/psql-target.mjs";

// --dsn wins, then SUPABASE_DB_URL, then the Supabase CLI's Docker container,
// which is what the DB Migrations workflow uses (it passes no flag).
const cli = argv.slice(2);
const target = psqlTarget(
  !cli.includes("--dsn") && env.SUPABASE_DB_URL ? ["--dsn", env.SUPABASE_DB_URL] : cli,
);

// Reach the database first, so an unreachable server is not read as a
// statement the database refused.
try {
  execFileSync(target.cmd, [...target.argv, "-c", "select 1"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  console.error(`[one-open-grade] cannot reach ${target.how}: ${String(e.stderr || e).trim().slice(0, 300)}`);
  console.error(`  ${target.hint}`);
  exit(2);
}

let passed = 0;
const failures = [];

function psql(text, { expectFailure = false } = {}) {
  try {
    const out = execFileSync(target.cmd, [...target.argv, "-v", "ON_ERROR_STOP=1", "-c", text], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    if (!expectFailure) throw err;
    return { ok: false, out: String(err.stderr ?? err.message) };
  }
}

function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function section(t) {
  console.log(`\n${t}`);
}

const USER = "eeee0001-0000-4000-8000-000000000001";
const ITEM = "eeee0002-0000-4000-8000-000000000002";
const OTHER = "eeee0003-0000-4000-8000-000000000003";

/**
 * The fixture, inside a transaction the caller rolls back.
 *
 * `users` is referenced by inventory_items, so a seller is created too. The
 * ids are fixed and distinctive so a crashed run leaves nothing findable.
 */
const SEED = `
  insert into auth.users (id, email) values ('${USER}', 'grade-lock@test.invalid')
    on conflict do nothing;
  insert into public.users (id, email) values ('${USER}', 'grade-lock@test.invalid')
    on conflict do nothing;
  insert into public.inventory_items (id, user_id, title, status)
    values ('${ITEM}', '${USER}', 'Lock fixture jacket', 'photographed'),
           ('${OTHER}', '${USER}', 'Lock fixture second', 'photographed')
    on conflict do nothing;
`;

function row(itemId, status) {
  return `insert into public.flipdesk_grading_submissions
            (inventory_item_id, tier, status, cost)
          values ('${itemId}', 'standard', '${status}', 0)`;
}

/** Run a statement expecting the index to refuse it. */
function refuses(name, statements) {
  const r = psql(`begin; ${SEED} ${statements}; rollback;`, { expectFailure: true });
  if (r.ok) {
    failures.push(`${name} -- the database ACCEPTED a row it should refuse`);
    console.log(`  FAIL  ${name}`);
    return;
  }
  if (!/duplicate key|uq_grading_submission_one_open_per_item/i.test(r.out)) {
    failures.push(`${name} -- refused for the WRONG reason: ${r.out.slice(0, 160)}`);
    console.log(`  FAIL  ${name} (wrong reason)`);
    return;
  }
  passed += 1;
  console.log(`  ok    ${name}`);
}

/** Run a statement expecting it to be accepted. */
function accepts(name, statements) {
  const r = psql(`begin; ${SEED} ${statements}; rollback;`, { expectFailure: true });
  if (r.ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
    return;
  }
  failures.push(`${name} -- refused: ${r.out.slice(0, 200)}`);
  console.log(`  FAIL  ${name}`);
}

console.log("one-open-grade-per-item (00821)");

section("the index exists and is the shape the code expects");
const idx = psql(`
  select indisunique, pg_get_expr(indpred, indrelid)
    from pg_index
   where indexrelid = 'public.uq_grading_submission_one_open_per_item'::regclass
`).out;
check("it is UNIQUE", idx.startsWith("t"), idx);
for (const state of ["pending", "processing", "pending_review"]) {
  check(`its predicate covers ${state}`, idx.includes(state), idx);
}
for (const state of ["completed", "failed", "expired", "disputed"]) {
  check(`and does NOT cover ${state}`, !idx.includes(`'${state}'`), idx);
}

section("a second open grade on one garment");
for (const first of ["pending", "processing", "pending_review"]) {
  for (const second of ["pending", "processing", "pending_review"]) {
    refuses(
      `${first} then ${second} is refused`,
      `${row(ITEM, first)}; ${row(ITEM, second)}`,
    );
  }
}

section("what it must NOT refuse");
accepts(
  "a re-grade after the first completed",
  `${row(ITEM, "completed")}; ${row(ITEM, "pending")}`,
);
accepts(
  "a re-grade after the first failed",
  `${row(ITEM, "failed")}; ${row(ITEM, "pending")}`,
);
accepts(
  "many finished grades on one garment",
  `${row(ITEM, "completed")}; ${row(ITEM, "completed")}; ${row(ITEM, "failed")}`,
);
accepts(
  "two different garments, both running",
  `${row(ITEM, "pending")}; ${row(OTHER, "pending")}`,
);
accepts(
  "the row is releasable: closing the first lets a second in",
  `${row(ITEM, "pending")};
   update public.flipdesk_grading_submissions set status = 'failed'
     where inventory_item_id = '${ITEM}';
   ${row(ITEM, "pending")}`,
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) exit(1);
