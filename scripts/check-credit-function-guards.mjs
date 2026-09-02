#!/usr/bin/env node
// US-3094 AC4 — read the CATALOG, not the migration text.
//
// THE FAILURE THIS EXISTS TO CATCH. Every credit function is either unreachable
// by `anon` or refuses `anon` in its own body. Nothing enforced that. A source
// scan cannot: `CREATE OR REPLACE` preserves an ACL but `DROP` + `CREATE`
// resets it to the PUBLIC default, so a future migration that re-creates one of
// these by dropping it re-opens the function AND loses the guard, in valid SQL
// that applies green. `pg_proc` is the only place that answers.
//
// WHY IT IS NOT "anon must not have EXECUTE". That was US-3094's first
// wording, and the catalog refutes it: measured 2026-09-02 on a stack built
// from every migration, `anon` holds EXECUTE on eight of the ten and has since
// they were created. Taking it away is what this repo will NOT do -- a denied
// function call from a role in `supautils.hint_roles` segfaults the backend and
// restarts the database (US-2403), and `anon` is the key in the browser bundle.
// So the invariant that is true, and the one worth freezing, is the OR:
// unreachable, or guarded.
//
// SELF-CHECK, because a detector that always says "clean" looks identical to a
// clean codebase. Two probe functions are created alongside the real query --
// one guarded, one not, both anon-executable on the CREATE default -- and this
// fails unless it flags exactly the unguarded one. This repo has shipped a
// guard that could never fire twice (US-2103, US-2104).
//
// Everything runs inside a transaction that is ROLLED BACK.

import { execFileSync, spawnSync } from "node:child_process";

import {
  DOCKER_PROBE_MS,
  DOCKER_QUERY_MS,
  dockerTimedOut,
  wedgedDaemonError,
} from "./lib/docker-timeout.mjs";

/**
 * The money-like functions. The two that 00216 revoked are included on purpose:
 * this fails if a grant ever comes BACK to them without a body guard arriving
 * in the same breath.
 */
const CREDIT_FUNCTIONS = [
  "grant_grade_credits",
  "debit_grade_credits",
  "revoke_grade_credits",
  "admin_adjust_credits",
  "grant_appstore_credits",
  "grant_buyer_reward_credit",
  "issue_buyer_reward_credit",
  "redeem_buyer_reward_credit",
  "reserve_ai_action",
  "refund_ai_action",
];

const MARK = "===GT-CREDIT-GUARD-BREAK===";

function dbContainer() {
  let out;
  try {
    out = execFileSync(
      "docker",
      ["ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}"],
      { encoding: "utf8", timeout: DOCKER_PROBE_MS },
    ).trim();
  } catch (err) {
    if (err?.code === "ETIMEDOUT") throw wedgedDaemonError("docker ps");
    throw err;
  }
  const name = out.split(/\r?\n/).filter(Boolean)[0];
  if (!name) {
    throw new Error(
      "no running supabase_db_* container — boot the local stack first (`supabase db start`)",
    );
  }
  return name;
}

// spawnSync, not execFileSync: psql writes errors to stderr and execFileSync
// hands back stdout only, which would assert against a truncated answer.
function psql(container, sql) {
  const res = spawnSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", timeout: DOCKER_QUERY_MS },
  );
  if (dockerTimedOut(res)) throw wedgedDaemonError("psql inside the db container");
  return { text: `${res.stdout ?? ""}${res.stderr ?? ""}`, status: res.status };
}

const names = CREDIT_FUNCTIONS.map((n) => `'${n}'`).join(", ");

// One predicate, used for the probes and for the real functions, so the
// self-check exercises the same expression the verdict comes from.
const OFFENDER_PREDICATE = `
      has_function_privilege('anon', p.oid, 'EXECUTE')
  AND p.prosrc NOT LIKE '%auth.role()%'
  AND p.prosrc NOT LIKE '%gt_require_role%'`;

const sql = `
begin;

-- ── Self-check probes ────────────────────────────────────────────────────
-- Neither is granted or revoked explicitly: they carry the CREATE default,
-- which is the same footing the real functions are on.
create function public.gt_credit_probe_guarded(p_x int)
returns int language plpgsql security definer as $probe_g$
begin
  if auth.role() <> 'service_role' then
    raise exception 'gt_credit_probe_guarded: service role required' using errcode = '42501';
  end if;
  return p_x;
end;
$probe_g$;

create function public.gt_credit_probe_open(p_x int)
returns int language plpgsql security definer as $probe_o$
begin
  return p_x;
end;
$probe_o$;

\\echo '${MARK}selfcheck'
select p.proname
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prokind = 'f'
  and p.proname in ('gt_credit_probe_guarded', 'gt_credit_probe_open')
  and (${OFFENDER_PREDICATE})
order by p.proname;

\\echo '${MARK}inventory'
select p.oid::regprocedure::text as sig,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       (p.prosrc like '%auth.role()%' or p.prosrc like '%gt_require_role%') as body_guard
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prokind = 'f'
  and p.proname in (${names})
order by 1;

\\echo '${MARK}offenders'
select p.oid::regprocedure::text as sig
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prokind = 'f'
  and p.proname in (${names})
  and (${OFFENDER_PREDICATE})
order by 1;

rollback;
`;

const container = dbContainer();
const { text, status } = psql(container, sql);

if (status !== 0) {
  console.error(text);
  console.error("check-credit-function-guards: psql failed — see the output above.");
  process.exit(1);
}

/** Rows of one psql section, as trimmed non-empty lines minus the header. */
function section(name) {
  const parts = text.split(`${MARK}${name}`);
  if (parts.length < 2) {
    throw new Error(`check-credit-function-guards: section '${name}' missing from psql output`);
  }
  const body = parts[1].split(MARK)[0];
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // psql prints "col", then a "---+---" rule, then rows, then "(n rows)".
    .filter((l) => !/^-+(\+-+)*$/.test(l));
  // Cut at the row count. Everything after it belongs to the next statement --
  // the trailing ROLLBACK read as an offender until this was here.
  const end = lines.findIndex((l) => /^\(\d+ rows?\)$/.test(l));
  if (end < 0) {
    throw new Error(
      `check-credit-function-guards: section '${name}' has no "(n rows)" line — psql output is not the shape this parses`,
    );
  }
  return lines.slice(1, end);
}

const failures = [];

// ── 1. Self-check ──────────────────────────────────────────────────────────
const flagged = section("selfcheck");
if (flagged.length !== 1 || flagged[0] !== "gt_credit_probe_open") {
  failures.push(
    `SELF-CHECK FAILED. The detector should flag exactly gt_credit_probe_open and ` +
      `leave gt_credit_probe_guarded alone; it flagged: ${flagged.join(", ") || "(nothing)"}. ` +
      `Until this passes, a clean result below means nothing.`,
  );
}

// ── 2. The real verdict ────────────────────────────────────────────────────
const inventory = section("inventory");
const offenders = section("offenders");

console.log("credit functions in the catalog (sig | anon EXECUTE | body guard):");
for (const row of inventory) console.log(`  ${row}`);

if (inventory.length < CREDIT_FUNCTIONS.length) {
  failures.push(
    `only ${inventory.length} of the ${CREDIT_FUNCTIONS.length} credit functions exist in this ` +
      `schema. A missing one is either a rename this list did not follow or a migration that ` +
      `did not apply — both make the verdict below meaningless.`,
  );
}

if (offenders.length > 0) {
  failures.push(
    `${offenders.length} credit function(s) are reachable with the public anon key AND carry no ` +
      `authorization check in the body:\n    ${offenders.join("\n    ")}\n` +
      `  Fix by adding the check to the BODY — public.gt_require_role(fn, 'service_role'), the ` +
      `shape 00640 settled on. Do NOT take the EXECUTE grant away: a denied function call from a ` +
      `role in supautils.hint_roles segfaults this Postgres image and restarts the database ` +
      `(US-2403), and anon is the key that ships in the browser bundle.`,
  );
}

if (failures.length > 0) {
  console.error("");
  for (const f of failures) console.error(`✗ ${f}`);
  process.exit(1);
}

console.log("");
console.log(
  `✓ ${inventory.length} credit functions: every one is either unreachable by anon or guarded in ` +
    `its own body (self-check passed).`,
);
