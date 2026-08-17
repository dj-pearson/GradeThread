#!/usr/bin/env node
// US-2662 AC3 — prove session revocation REVOKES, rather than proving the call
// is written.
//
// WHY THIS SHAPE. The test that existed asserted the route source contained
// `await revokeUserSessions(session.target_id)`. That assertion was true the
// whole time the feature did nothing: the code was correct and the endpoint it
// called did not exist, so every stop 404'd and the target's refresh token
// stayed live. A test that reads the source can never catch that, because the
// source is not the part that is wrong.
//
// So this one seeds a session, calls the function, and looks at what is left.
// It fails if the rows survive — which is the only fact the feature is about.
//
// The three checks:
//   1. an anonymous caller is refused (42501), not merely ineffective
//   2. a seeded session AND its refresh token are gone after the call, and the
//      return value equals the number of sessions there were
//   3. a user with no sessions returns 0 rather than raising
//
// Check 2 leans on a schema fact worth stating: refresh_tokens_session_id_fkey
// is ON DELETE CASCADE, which is why deleting sessions is sufficient and the
// function does not touch auth.refresh_tokens itself. If that FK ever changes,
// this check goes red rather than the behaviour going quiet.
//
// SAFETY. Everything runs in one transaction that is ALWAYS rolled back,
// against the LOCAL throwaway stack. The seeded user is a syntactically invalid
// email under .invalid, so it cannot collide with a real row.
//
// Run: node scripts/check-session-revocation.mjs
//   (needs Docker + the local Supabase stack; skips cleanly without them)

import { spawnSync } from "node:child_process";

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_gradethread";
const PROBE_ID = "00000000-0000-0000-0000-0000000ffff1";
const PROBE_EMAIL = "revoke-probe@example.invalid";

const psql = (args, input) =>
  spawnSync("docker", [
    "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", ...args,
  ], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

const SQL = `
begin;
set local statement_timeout = '10s';

-- Seed: one user, two sessions, one refresh token hanging off the first.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values ('${PROBE_ID}', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', '${PROBE_EMAIL}', 'x', now(), now());
insert into auth.sessions (id, user_id, created_at, updated_at)
values (gen_random_uuid(), '${PROBE_ID}', now(), now()),
       (gen_random_uuid(), '${PROBE_ID}', now(), now());
insert into auth.refresh_tokens (token, user_id, session_id, created_at, updated_at)
select 'probe-token', '${PROBE_EMAIL}', id, now(), now()
from auth.sessions where user_id = '${PROBE_ID}' limit 1;

do $probe$
declare
  refused boolean := false;
  seeded integer;
  tokens_before integer;
  returned integer;
  sessions_after integer;
  tokens_after integer;
  none integer;
begin
  -- 1. the guard refuses anon. A function that merely returned 0 for anon would
  --    be a silent no-op, which is the failure mode this whole story is about.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    perform public.revoke_user_sessions('${PROBE_ID}'::uuid);
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    -- Stop here on purpose. An unguarded function has just RUN as anon, so the
    -- seeded rows are already gone and every later check would report a second,
    -- misleading failure about a state this check itself destroyed.
    raise notice 'REVOKE_FAIL|anon was not refused 42501 — remaining checks skipped, the probe state is spent';
    return;
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select count(*) into seeded from auth.sessions where user_id = '${PROBE_ID}';
  select count(*) into tokens_before from auth.refresh_tokens
    where session_id in (select id from auth.sessions where user_id = '${PROBE_ID}');
  if seeded = 0 or tokens_before = 0 then
    raise notice 'REVOKE_FAIL|seed did not take (sessions=%, tokens=%)', seeded, tokens_before;
    return;
  end if;

  -- 2. the actual claim.
  returned := public.revoke_user_sessions('${PROBE_ID}'::uuid);
  select count(*) into sessions_after from auth.sessions where user_id = '${PROBE_ID}';
  select count(*) into tokens_after from auth.refresh_tokens where token = 'probe-token';

  if sessions_after <> 0 then
    raise notice 'REVOKE_FAIL|% session(s) survived the call', sessions_after;
  end if;
  if tokens_after <> 0 then
    raise notice 'REVOKE_FAIL|refresh token survived — the ON DELETE CASCADE this relies on is gone';
  end if;
  if returned <> seeded then
    raise notice 'REVOKE_FAIL|returned % for % seeded session(s)', returned, seeded;
  end if;

  -- 3. no sessions is not an error.
  none := public.revoke_user_sessions('${PROBE_ID}'::uuid);
  if none <> 0 then
    raise notice 'REVOKE_FAIL|second call returned %, expected 0', none;
  end if;

  raise notice 'REVOKE_OK|% sessions and % token(s) removed', returned, tokens_before;
end
$probe$;

rollback;
`;

export function run() {
  const probe = psql(["-At", "-c", "select 1"]);
  if (probe.status !== 0) {
    return { skipped: `local stack not reachable (${CONTAINER})` };
  }

  const exists = psql(["-At", "-c",
    "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
    "where n.nspname = 'public' and p.proname = 'revoke_user_sessions';"]);
  if (exists.stdout.trim() === "0") {
    return { failures: ["public.revoke_user_sessions does not exist — 00614 did not apply"] };
  }

  const res = psql(["-v", "ON_ERROR_STOP=1"], SQL);
  // RAISE NOTICE goes to STDERR. Reading stdout only is how an earlier sweep in
  // this repo reported "none found" while the finding printed to the terminal.
  const out = `${res.stdout}\n${res.stderr}`;
  const failures = [...out.matchAll(/REVOKE_FAIL\|([^\n]*)/g)].map((m) => m[1].trim());

  if (res.status !== 0 && failures.length === 0) {
    failures.push(`psql exited ${res.status}: ${res.stderr.trim().split("\n").slice(-3).join(" / ")}`);
  }
  if (!out.includes("REVOKE_OK") && failures.length === 0) {
    failures.push("the probe never reached its success line — it did not run to completion");
  }
  return { failures, ok: [...out.matchAll(/REVOKE_OK\|([^\n]*)/g)].map((m) => m[1].trim()) };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-session-revocation.mjs")) {
  const r = run();
  if (r.skipped) {
    console.log(`⚠ session-revocation check SKIPPED: ${r.skipped}`);
    process.exit(0);
  }
  if (r.failures.length > 0) {
    console.error("✗ session revocation is NOT happening:");
    for (const f of r.failures) console.error(`    ${f}`);
    process.exit(1);
  }
  console.log(`✓ session revocation verified — ${r.ok.join("; ")}`);
}
