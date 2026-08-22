#!/usr/bin/env node
// US-1927 AC3 — prove the PLANNER hoists auth.uid() to an InitPlan.
//
// rls-guard_test.ts already pins the SOURCE form: it fails a migration whose
// policy calls a bare auth.uid() instead of (select auth.uid()). That is a
// static check over SQL text, and it cannot answer the question the story
// actually asks — whether Postgres evaluates the expression ONCE per query
// (an InitPlan) or once per candidate row. Those are different assertions and
// confirming the first does not confirm the second.
//
// So this runs EXPLAIN against the local throwaway stack and asserts on the
// plan. It carries its own SELF-CHECK: alongside the real policy it builds a
// deliberately-bare one and requires that to come back WITHOUT an InitPlan.
// Without that, a detector that always says "found it" would look green
// forever — this repo has shipped that guard twice (US-2103, US-2104), and
// US-1927's own notes are the reason the pattern is repeated here.
//
// Everything runs inside a transaction that is ROLLED BACK, so the stack is
// left exactly as found.

import { execFileSync, spawnSync } from "node:child_process";

// US-2788: bounded, so a wedged daemon fails this lane instead of hanging it.
import {
  DOCKER_PROBE_MS,
  DOCKER_QUERY_MS,
  dockerTimedOut,
  wedgedDaemonError,
} from "./lib/docker-timeout.mjs";

const MARK = "===GT-PLAN-BREAK===";

function dbContainer() {
  let out;
  try {
    out = execFileSync(
      "docker",
      ["ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}"],
      { encoding: "utf8", timeout: DOCKER_PROBE_MS },
    ).trim();
  } catch (err) {
    // A wedged daemon is a different problem from an absent one, and the
    // operator action is different too.
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
// returns stdout only, which would silently assert against a truncated plan.
function psql(container, sql) {
  const res = spawnSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", timeout: DOCKER_QUERY_MS },
  );
  // Throw rather than hand back a null status, which the caller would read as
  // an ordinary psql failure and report as a plan difference.
  if (dockerTimedOut(res)) throw wedgedDaemonError("psql inside the db container");
  return { text: `${res.stdout ?? ""}${res.stderr ?? ""}`, status: res.status };
}

const container = dbContainer();

const sql = `
begin;

-- Two probe tables that differ ONLY in the policy form, so the comparison
-- isolates the thing under test.
create table public.gt_initplan_probe_good (id bigserial primary key, user_id uuid not null, payload text);
create table public.gt_initplan_probe_bare (id bigserial primary key, user_id uuid not null, payload text);
alter table public.gt_initplan_probe_good enable row level security;
alter table public.gt_initplan_probe_bare enable row level security;
create policy p_good on public.gt_initplan_probe_good for select using ((select auth.uid()) = user_id);
create policy p_bare on public.gt_initplan_probe_bare for select using (auth.uid() = user_id);
grant select on public.gt_initplan_probe_good, public.gt_initplan_probe_bare to authenticated;

-- A multi-tenant shape: several owners, so the scan meets rows it must reject.
insert into public.gt_initplan_probe_good (user_id, payload)
select ('00000000-0000-0000-0000-0000000000' || lpad((g % 20)::text, 2, '0'))::uuid, 'row ' || g
from generate_series(1, 5000) g;
insert into public.gt_initplan_probe_bare (user_id, payload)
select user_id, payload from public.gt_initplan_probe_good;
analyze public.gt_initplan_probe_good;
analyze public.gt_initplan_probe_bare;

-- The real table needs the same explicit grant the probes get. Prod has it —
-- the SPA reads submissions with the anon key — but it comes from Supabase's
-- ALTER DEFAULT PRIVILEGES, which is attached to the role that CREATED the
-- object, and on the throwaway stack the applying role is not always that
-- role. Since 2026-08-08 it has not been: every run since died here on
-- "permission denied for table submissions" before reaching a single EXPLAIN,
-- so this check has reported nothing for a week while looking like a
-- migration failure. Granting inside the transaction that gets rolled back
-- costs nothing and removes the dependency on who applied the schema. It
-- cannot mask a real regression either: the question under test is what the
-- PLANNER does with auth.uid(), and a grant does not change a plan.
grant select on public.submissions to authenticated;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-000000000007', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

select '${MARK}';
explain (analyze, verbose, costs off, timing off, summary off)
  select id, payload from public.gt_initplan_probe_good;

select '${MARK}';
explain (analyze, verbose, costs off, timing off, summary off)
  select id, payload from public.gt_initplan_probe_bare;

select '${MARK}';
explain (analyze, verbose, costs off, timing off, summary off)
  select id, title, status from public.submissions order by created_at desc limit 100;

rollback;
`;

const { text, status } = psql(container, sql);
const sections = text.split(MARK).slice(1);

if (status !== 0 || sections.length < 3) {
  console.error("US-1927 initplan check could not run:\n");
  console.error(text.trim());
  process.exit(1);
}

const [goodPlan, barePlan, realPlan] = sections;

// "InitPlan" appearing anywhere is not enough — it has to be what the row
// filter actually references, which is the difference between hoisted and
// merely present.
const usesInitPlan = (plan) => /InitPlan/.test(plan) && /\(InitPlan \d+\)\.col\d+/.test(plan);

const failures = [];
if (!usesInitPlan(goodPlan)) {
  failures.push("the `(select auth.uid())` probe policy did NOT plan as an InitPlan");
}
if (usesInitPlan(barePlan)) {
  failures.push(
    "SELF-CHECK FAILED: the deliberately-bare `auth.uid()` probe ALSO planned as an " +
      "InitPlan, so this check cannot tell the two forms apart and its green means nothing",
  );
}
if (!usesInitPlan(realPlan)) {
  failures.push(
    "public.submissions — a real hot per-user table — did NOT plan as an InitPlan; " +
      "auth.uid() is being re-evaluated per candidate row",
  );
}

if (failures.length > 0) {
  console.error("US-1927 REGRESSION — RLS is not hoisting auth.uid() to an InitPlan:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("\n--- plan: (select auth.uid()) probe ---" + goodPlan.trimEnd());
  console.error("\n--- plan: bare auth.uid() probe ---" + barePlan.trimEnd());
  console.error("\n--- plan: public.submissions ---" + realPlan.trimEnd());
  console.error(
    "\n  Fix: rewrite the policy as USING ((select auth.uid()) = user_id). See " +
      "supabase/migrations/00451_rls_initplan_perf.sql for the shape.",
  );
  process.exit(1);
}

console.log(
  "✓ RLS hoists auth.uid() to an InitPlan on public.submissions " +
    "(self-check: the bare-form probe correctly did not)",
);
