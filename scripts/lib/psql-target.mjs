// Where a fixture-running script should send its SQL, in one place.
//
// THREE SCRIPTS NEEDED THIS AND THE FIRST TWO DISAGREED. check-sku-sequences
// only knew how to reach a Postgres inside the Supabase CLI's Docker container,
// which is why its own fixtures had never run in a cloud session: dockerd
// starts there but no registry blob can be pulled, while Postgres 16 sits
// installed on the box with every migration applied. --dsn fixed that one, and
// this is the shared home so the third copy does not drift.
//
// ⚠ psql prints RAISE NOTICE on STDERR. A runner reading stdout alone reports
// "nothing was proved" against a database that just proved it, which is exactly
// what happened while US-2670's runner was being written. `runFixture` reads
// both streams for that reason.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const DEFAULT_CONTAINER = "supabase_db_gradethread";

/**
 * Resolve the psql invocation from argv and the environment.
 *
 * A DSN beats the container, and the container path keeps its own advice so a
 * flag cannot silently change the default CI and the Windows box both use.
 */
export function psqlTarget(argv = process.argv.slice(2), env = process.env) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const container = at("--container") ?? DEFAULT_CONTAINER;
  const dsn = at("--dsn") ?? env.SKU_CHECK_DSN ?? env.FIXTURE_DSN;
  if (dsn) {
    return {
      cmd: "psql",
      argv: [dsn, "-tA"],
      how: `psql against ${dsn}`,
      hint: "Check the connection string, and that the server is up.",
    };
  }
  return {
    cmd: "docker",
    argv: ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-tA"],
    how: `Postgres in container "${container}"`,
    hint: `Start it with: docker start ${container}\n  ` +
      `Or point this at any Postgres carrying the migrations: --dsn "postgresql://..."`,
  };
}

/**
 * Did the command fail to REACH a database, as opposed to running and
 * disagreeing with us?
 *
 * ⚠ "it printed something" is not the test, and reading it that way is what
 * regressed check-sku-sequences: psql prints its connection refusal on stderr,
 * so an ok-means-non-empty rule called an unreachable server a successful run
 * and the caller fell through to "the fixture printed no result object". The
 * operator then reads a fixture problem where there is a connection problem.
 */
//
// ⚠ The Docker CLI reworded its no-daemon error. Docker 29 prints "failed to
// connect to the docker API at unix:///var/run/docker.sock"; older clients
// print "Cannot connect to the Docker daemon". Matching only the old wording
// sent a box with no daemon down the same "printed no result object" path.
export function looksUnreachable(out, status) {
  if (status === 0) return false;
  return /connection to server|could not connect|Connection refused|no such host|Cannot connect to the Docker daemon|failed to connect to the docker API|No such container|Error response from daemon|is not running/i
    .test(out);
}

/**
 * Run one .sql fixture and hand back everything psql said, both streams.
 *
 * Returns `{ ok, out, status }`. `ok: false` means the database could not be
 * reached; a fixture that ran and FAILED an assertion still returns ok,
 * because its answer is in the output and the caller is what decides.
 */
export function runFixture(target, path, { includes = {}, args = [] } = {}) {
  if (!existsSync(path)) return { ok: false, out: `fixture missing: ${path}` };
  let sql = readFileSync(path, "utf8");

  // ⚠ psql's \ir resolves against the SCRIPT FILE's directory, and a fixture
  // arriving on STDIN has no directory, so \ir fails with "No such file".
  // Piping is the only shape that works for both a DSN and `docker exec`, so a
  // fixture that needs another file names a placeholder and the caller splices
  // the real text in. The migration is still read from disk, never copied.
  for (const [marker, file] of Object.entries(includes)) {
    if (!existsSync(file)) return { ok: false, out: `include missing: ${file}` };
    if (!sql.includes(marker)) {
      return { ok: false, out: `fixture ${path} has no placeholder ${marker}` };
    }
    // ⚠ A FUNCTION, not the string. `$$` in a replacement string is JavaScript's
    // escape for a literal `$`, so a plain replaceAll turns every dollar-quoted
    // plpgsql block into `do $ ... $` and psql answers "syntax error at or near
    // $". Measured, on this exact migration.
    const text = readFileSync(file, "utf8");
    sql = sql.replaceAll(marker, () => text);
  }

  // `args` are extra psql flags a fixture needs, e.g. -F "|" for a separator
  // its parser expects. They go at the END so they win over the defaults.
  const run = spawnSync(target.cmd, [...target.argv, ...args], {
    input: sql,
    encoding: "utf8",
  });
  const out = String(run.stdout ?? "") + String(run.stderr ?? "");
  const status = run.status ?? (run.error ? -1 : 0);
  return { ok: !run.error && !looksUnreachable(out, status), out, status };
}
