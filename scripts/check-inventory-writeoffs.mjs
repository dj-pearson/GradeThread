#!/usr/bin/env node
// US-3007 - prove an item that left inventory WITHOUT selling actually leaves,
// and that a personal-use withdrawal lands on the right line of the form.
//
// WHY A DATABASE AND NOT A SOURCE SCAN. The defect this guards was a missing
// clause in a WHERE, and the arithmetic that replaced it spans two functions:
// take_inventory_snapshot decides what is held, cogs_worksheet decides what that
// costs. Reading either one alone shows nothing wrong. The only fact worth
// asserting is what the numbers come out as, and that needs rows.
//
// WHAT IT CHECKS
//   1. ending inventory holds ONLY the still-held item. The written-off and the
//      personal-use items are gone from their removed_on date. That is the whole
//      bug: before 00690 a completed sale was the only exit, so both sat in
//      ending inventory for ever, overstating Schedule C line 41 and
//      understating line 42 COGS.
//   2. personal use nets off line 36, NOT off ending inventory. Schedule C
//      Part III line 36 reads "Purchases less cost of items withdrawn for
//      personal use", so the two reasons take different routes on purpose.
//   3. variance_after_writeoffs_cents reconciles to ZERO while variance_cents
//      does not. That asymmetry IS the design: a write-off books no ledger
//      entry, so the raw variance is legitimately non-zero, and the residual is
//      the figure that should balance.
//   4. the pair constraint refuses a removed_on with no reason. A date with no
//      reason cannot be routed to a line of the form, so the half-record is
//      rejected rather than silently misfiled.
//
// SAFETY. One transaction, always rolled back, against the LOCAL throwaway
// stack. The seeded user is under .invalid so it cannot collide with a real row.
//
// Run: node scripts/check-inventory-writeoffs.mjs
//   (needs Docker + the local Supabase stack; skips cleanly without them)

import { spawnSync } from "node:child_process";

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_gradethread";
const PROBE_ID = "00000000-0000-0000-0000-0000000ffff7";
const PROBE_EMAIL = "writeoff-probe@example.invalid";

const psql = (args, input) =>
  spawnSync("docker", [
    "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", ...args,
  ], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

const SQL = `
begin;
set local statement_timeout = '20s';

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values ('${PROBE_ID}', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', '${PROBE_EMAIL}', 'x', now(), now());

-- Three identical items at 100 each, differing only in how they left.
insert into public.inventory_items
  (user_id, title, status, acquired_date, acquired_price, removed_on, removed_reason)
values
  ('${PROBE_ID}', 'held',     'sourced', '2025-01-15', 100, null,         null),
  ('${PROBE_ID}', 'damaged',  'sourced', '2025-01-15', 100, '2025-06-15', 'damaged'),
  ('${PROBE_ID}', 'personal', 'sourced', '2025-01-15', 100, '2025-06-20', 'personal_use');

do $probe$
declare
  w            jsonb;
  ending_cnt   integer;
  ending_cost  bigint;
  titles       text;
  rejected     boolean := false;
begin
  perform public.take_inventory_snapshot('${PROBE_ID}'::uuid, '2025-01-01', 'open',  false);
  perform public.take_inventory_snapshot('${PROBE_ID}'::uuid, '2025-12-31', 'close', false);

  select s.item_count, s.total_cost_cents into ending_cnt, ending_cost
    from public.inventory_snapshots s
   where s.user_id = '${PROBE_ID}' and s.as_of = '2025-12-31';

  select string_agg(si.title, ',' order by si.title) into titles
    from public.inventory_snapshot_items si
    join public.inventory_snapshots s on s.id = si.snapshot_id
   where s.as_of = '2025-12-31' and s.user_id = '${PROBE_ID}';

  -- 1. only the held item survives to ending inventory.
  if coalesce(titles, '') <> 'held' then
    raise notice 'WRITEOFF_FAIL|ending inventory holds %, expected only held', coalesce(titles, '(none)');
  end if;
  if ending_cnt <> 1 or ending_cost <> 10000 then
    raise notice 'WRITEOFF_FAIL|ending is % items / % cents, expected 1 / 10000', ending_cnt, ending_cost;
  end if;

  w := public.cogs_worksheet('2025-01-01', '2025-12-31');

  -- 2. personal use reduces line 36, and does NOT reduce ending inventory.
  if (w->>'line_36_gross_purchases_cents')::bigint <> 30000 then
    raise notice 'WRITEOFF_FAIL|gross purchases %, expected 30000', w->>'line_36_gross_purchases_cents';
  end if;
  if (w->>'line_36_personal_use_cents')::bigint <> 10000 then
    raise notice 'WRITEOFF_FAIL|personal use %, expected 10000', w->>'line_36_personal_use_cents';
  end if;
  if (w->>'line_36_purchases_cents')::bigint <> 20000 then
    raise notice 'WRITEOFF_FAIL|line 36 net %, expected 20000 (30000 less the withdrawal)', w->>'line_36_purchases_cents';
  end if;

  -- 3. the write-off is reported, and the residual balances even though the raw
  --    variance does not.
  if (w->>'writeoffs_cents')::bigint <> 10000 then
    raise notice 'WRITEOFF_FAIL|writeoffs %, expected 10000', w->>'writeoffs_cents';
  end if;
  if (w->>'variance_after_writeoffs_cents')::bigint <> 0 then
    raise notice 'WRITEOFF_FAIL|residual %, expected 0 - the write-off should explain the whole variance', w->>'variance_after_writeoffs_cents';
  end if;
  if (w->>'variance_cents')::bigint = 0 then
    raise notice 'WRITEOFF_FAIL|raw variance is 0, but a write-off books no ledger entry so it must not be, or the residual proves nothing';
  end if;

  -- 4. a date with no reason is refused.
  begin
    insert into public.inventory_items (user_id, title, status, removed_on)
    values ('${PROBE_ID}', 'half a record', 'sourced', '2025-01-01');
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise notice 'WRITEOFF_FAIL|removed_on with no reason was ACCEPTED, the pair constraint is gone';
  end if;

  raise notice 'WRITEOFF_OK|ending=% items / % cents, line36=%, writeoffs=%, residual=%',
    ending_cnt, ending_cost, w->>'line_36_purchases_cents',
    w->>'writeoffs_cents', w->>'variance_after_writeoffs_cents';
end
$probe$;

rollback;
`;

export function run() {
  const probe = psql(["-At", "-c", "select 1"]);
  if (probe.status !== 0) {
    return { skipped: `local stack not reachable (${CONTAINER})` };
  }

  const cols = psql(["-At", "-c",
    "select count(*) from information_schema.columns where table_schema='public' " +
    "and table_name='inventory_items' and column_name in ('removed_on','removed_reason');"]);
  if (cols.stdout.trim() !== "2") {
    return { failures: ["inventory_items.removed_on/removed_reason missing - 00690 did not apply"] };
  }

  const res = psql(["-v", "ON_ERROR_STOP=1"], SQL);
  // RAISE NOTICE goes to STDERR. Reading stdout only is how an earlier sweep in
  // this repo reported "none found" while the finding printed to the terminal.
  const out = `${res.stdout}\n${res.stderr}`;
  const failures = [...out.matchAll(/WRITEOFF_FAIL\|([^\n]*)/g)].map((m) => m[1].trim());

  if (res.status !== 0 && failures.length === 0) {
    failures.push(`psql exited ${res.status}: ${res.stderr.trim().split("\n").slice(-3).join(" / ")}`);
  }
  if (!out.includes("WRITEOFF_OK") && failures.length === 0) {
    failures.push("the probe never reached its success line - it did not run to completion");
  }
  return { failures, ok: [...out.matchAll(/WRITEOFF_OK\|([^\n]*)/g)].map((m) => m[1].trim()) };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-inventory-writeoffs.mjs")) {
  const r = run();
  if (r.skipped) {
    console.log(`⚠ inventory-writeoff check SKIPPED: ${r.skipped}`);
    process.exit(0);
  }
  if (r.failures.length > 0) {
    console.error("✗ inventory write-offs are NOT accounted for:");
    for (const f of r.failures) console.error(`    ${f}`);
    process.exit(1);
  }
  console.log(`✓ inventory write-offs verified - ${r.ok.join("; ")}`);
}
