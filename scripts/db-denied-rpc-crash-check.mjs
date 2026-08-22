#!/usr/bin/env node
// US-2403 regression check — a denied function call must ERROR, not SEGFAULT.
//
// On the Supabase Postgres image the supautils "permission denied" hint path
// crashes the backend with signal 11 when the calling role is listed in
// supautils.hint_roles (which is exactly `anon, authenticated, service_role`).
// The whole database then restarts. Any holder of the public anon key can do it
// with one PostgREST RPC call, so this is a remote restart-at-will, not a
// local curiosity.
//
// This check is deliberately image-level rather than schema-level: nothing in
// supabase/migrations/ can fix it (supautils refuses ALTER SYSTEM on
// hint_roles even for a superuser — the fix is a postgresql.conf change), so a
// migration guard would be looking in the wrong place. What CAN regress is the
// image: an upgrade that fixes it can be rolled back, and an image that has
// never been checked gets assumed-good. So the assertion is behavioural —
// revoke EXECUTE on a scratch function, call it as anon, and require a clean
// error with the postmaster still on its original start time.
//
// Runs against the LOCAL throwaway stack only (verify.mjs --db / db-migrations
// CI). It never touches prod: the test IS the denial of service.

import { execFileSync, spawnSync } from "node:child_process";

// US-2788: every docker call here is bounded. A wedged daemon answers nothing,
// and without a timeout this script hangs inside a lane that holds verify.lock.
import {
  DOCKER_PROBE_MS,
  DOCKER_QUERY_MS,
  dockerTimedOut,
  wedgedDaemonError,
} from "./lib/docker-timeout.mjs";

const FN = "gt_denied_rpc_crash_check_us2403";

function dockerPsqlContainer() {
  let out;
  try {
    out = execFileSync("docker", [
      "ps",
      "--filter",
      "name=supabase_db_",
      "--format",
      "{{.Names}}",
    ], { encoding: "utf8", timeout: DOCKER_PROBE_MS }).trim();
  } catch (err) {
    // ETIMEDOUT here is not "docker is missing" and not "no container". It is a
    // daemon that is up and answering nothing, which needs a different action
    // from the operator, so it gets a different sentence.
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

// psql exits 0 even when the server dies mid-statement, so callers assert on
// the TEXT, never on the exit code. spawnSync (not execFileSync) because the
// text we care about — "permission denied for function" — is on STDERR, and
// execFileSync returns stdout only.
function psql(container, sql, extraArgs = []) {
  const res = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=0",
      ...extraArgs,
    ],
    { input: sql, encoding: "utf8", timeout: DOCKER_QUERY_MS },
  );
  // A timeout must THROW rather than return "". Callers assert on the TEXT, so
  // an empty string from a wedged daemon would read as "the expected error was
  // not present" and fail this check for the wrong reason.
  if (dockerTimedOut(res)) throw wedgedDaemonError("psql inside the db container");
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

// -t -A rather than \pset, which echoes "Output format is unaligned." into the
// value and made the first draft's failure message unreadable.
function scalar(container, sql) {
  return psql(container, sql, ["-t", "-A"]).trim();
}

// After a crash the server comes back in recovery mode; reading the postmaster
// start time too early reports a connection failure instead of the restart we
// are actually trying to name. Wait for it, bounded.
function waitReady(container, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      execFileSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], {
        stdio: "ignore",
        timeout: DOCKER_PROBE_MS,
      });
      return true;
    } catch {
      // Bounded too: this is the SLEEP, so an unbounded call here would turn
      // the retry loop into the hang it exists to survive.
      execFileSync("docker", ["exec", container, "sleep", "1"], {
        stdio: "ignore",
        timeout: DOCKER_PROBE_MS,
      });
    }
  }
  return false;
}

const container = dockerPsqlContainer();
const hintRoles = scalar(container, "show supautils.hint_roles;");

// NOT pg_postmaster_start_time(): a backend SIGSEGV is handled by crash
// RECOVERY, and the postmaster itself never restarts, so that value is
// identical either way. The first draft asserted on it and could not fail.
// The server log is where the blast radius is actually visible — counted
// before and after rather than filtered with `docker logs --since`, because
// that compares against the daemon's clock, which on Docker Desktop lives in
// a separate VM and does not reliably agree with the container's now().
const CRASH_MARKER = /terminated by signal|reinitializing|automatic recovery in progress/gi;

function crashMarkerCount() {
  // spawnSync, not execFileSync: Postgres logs to the container's STDERR, and
  // execFileSync returns stdout only — so the first draft counted an empty
  // string and this assertion could never fire.
  const res = spawnSync("docker", ["logs", container], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: DOCKER_PROBE_MS,
  });
  if (dockerTimedOut(res)) throw wedgedDaemonError("docker logs");
  const log = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return (log.match(CRASH_MARKER) ?? []).length;
}

const crashMarkersBefore = crashMarkerCount();

psql(
  container,
  `create or replace function public.${FN}() returns int language sql as $$ select 1 $$;\n` +
    `revoke execute on function public.${FN}() from public, anon, authenticated;\n`,
);

const attempt = psql(container, `set role anon;\nselect public.${FN}();\n`);

waitReady(container);

// Cleanup runs before the assertions so a failure still leaves the stack tidy.
psql(container, `drop function if exists public.${FN}();\n`);

const crashMarkersAfter = crashMarkerCount();

const failures = [];
if (/server closed the connection|connection to server was lost/i.test(attempt)) {
  failures.push("the connection was dropped mid-statement (the crash signature)");
}
if (crashMarkersAfter > crashMarkersBefore) {
  failures.push(
    "the server log gained a backend-crash / recovery line during the call — " +
      "every OTHER connected session was terminated too",
  );
}
if (!/permission denied for function/i.test(attempt)) {
  failures.push('no clean "permission denied for function" error was returned');
}

if (failures.length > 0) {
  console.error("US-2403 REGRESSION — a denied function call did not fail cleanly:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n  supautils.hint_roles = ${JSON.stringify(hintRoles)}`);
  console.error(
    "\n  Mitigation (verified 2026-08-08 on public.ecr.aws/supabase/postgres:17.6.1.106):\n" +
      "  set `supautils.hint_roles = ''` in /etc/postgresql-custom/supautils.conf and restart\n" +
      "  Postgres. The hint only appends a GRANT suggestion to the error message, so clearing\n" +
      "  it costs nothing. It CANNOT be done from SQL — supautils rejects ALTER SYSTEM on that\n" +
      "  parameter even as superuser — so it is a config change on the host, not a migration.",
  );
  process.exit(1);
}

console.log(
  `✓ denied function call errored cleanly and the server stayed up ` +
    `(supautils.hint_roles = ${JSON.stringify(hintRoles)})`,
);
