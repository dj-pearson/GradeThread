// US-3394: the production guard on scripts/ops/restore-postgres.sh gets a test,
// because it had never once run.
//
// ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
// The only thing between `pg_restore --clean --if-exists` and a database was:
//
//     case "$TARGET" in
//       *gradethread.com*) [ "$ALLOW_PROD_RESTORE" = 1 ] || exit 1 ;;
//     esac
//
// No GradeThread Postgres DSN contains "gradethread.com". The documented shape
// (services/edge-functions/.env.example) is
// `postgres://postgres:...@db-host:5432/postgres`, migrate-prod.mjs reaches
// prod over ssh plus `docker exec` with no URL at all, and the backup cron runs
// on the DB host itself. So the arm never matched anything, the guard never
// fired, and vault/10-ops/backups.md called the script "prod-guarded" for three
// months. Nothing in the repo referenced `restore-postgres.sh` or
// `ALLOW_PROD_RESTORE` except prose, and restore-drill.sh reimplements the
// restore rather than calling this script, so the drill never exercised it
// either.
//
// ── HOW THIS TESTS IT ────────────────────────────────────────────────────────
// The script is EXECUTED, never source-scanned. Two ways, both real:
//
//   1. Sourced with RESTORE_POSTGRES_SOURCE_ONLY=1, which returns before the
//      destructive half, so the decision functions can be called directly.
//   2. Run end to end against FAKE `pg_restore` and `psql` binaries on PATH.
//      The fakes record every invocation, so "the guard refused" is proved by
//      pg_restore never being called, not by reading a message.
//
// No test here touches a database. The fakes are the point: a guard test that
// needed Postgres would not run, and a guard that does not run is how this
// defect survived.
import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "ops", "restore-postgres.sh");

/** `sh` is not on PATH for a child process on Windows; Git ships `bash`. */
function resolveShell() {
  for (const candidate of ["bash", "sh"]) {
    if (spawnSync(candidate, ["-c", "exit 0"]).status === 0) return candidate;
  }
  // Throw rather than skip. A guard that quietly does not run is worse than one
  // that is absent, because the green reads as evidence. That is this story.
  throw new Error("neither bash nor sh is runnable; cannot exercise restore-postgres.sh");
}

/** C:\a\b -> /c/a/b, so the path survives being put inside a POSIX $PATH. */
function posixPath(p) {
  const forward = p.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\//.exec(forward);
  return drive ? `/${drive[1].toLowerCase()}/${forward.slice(3)}` : forward;
}

let SHELL = "";
beforeAll(() => {
  SHELL = resolveShell();
});

/** Run a snippet with the script's pure half sourced. */
function sourced(snippet, env = {}) {
  const r = spawnSync(
    SHELL,
    ["-c", `RESTORE_POSTGRES_SOURCE_ONLY=1 . "$1" || exit 99\n${snippet}`, "sh", posixPath(SCRIPT)],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...env } },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Fake pg_restore / psql, so a full run needs no database.
// ---------------------------------------------------------------------------
const FAKE_PG_RESTORE = `#!/usr/bin/env bash
echo "pg_restore $*" >> "$FAKE_CALLS"
for a in "$@"; do
  if [ "$a" = "--list" ]; then
    printf '%s\\n' "$FAKE_TOC"
    exit 0
  fi
done
echo "pg_restore: restoring data for table \\"public.users\\""
if [ -n "\${FAKE_RESTORE_IGNORED:-}" ]; then
  echo "pg_restore: warning: errors ignored on restore: $FAKE_RESTORE_IGNORED" >&2
fi
exit "\${FAKE_RESTORE_RC:-0}"
`;

const FAKE_PSQL = `#!/usr/bin/env bash
echo "psql $*" >> "$FAKE_CALLS"
sql=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-c" ]; then sql="$a"; fi
  prev="$a"
done
case "$sql" in
  *pg_class*) printf '%s\\n' "$FAKE_TABLES" ;;
  *) printf '%s\\n' "$FAKE_COUNTS" ;;
esac
exit 0
`;

const DEFAULT_TOC = [
  ";",
  "; Archive created at 2026-09-11 02:00:00 UTC",
  ";     dbname: postgres",
  ";",
  "215; 1259 16404 TABLE public users postgres",
  "216; 1259 16410 TABLE public submissions postgres",
  "217; 1259 16420 TABLE public grade_reports postgres",
  "218; 1259 16430 TABLE storage objects supabase_storage_admin",
  "3401; 0 16404 TABLE DATA public users postgres",
  "3402; 0 16410 TABLE DATA public submissions postgres",
].join("\n");

const DEFAULT_TABLES = [
  "public.users",
  "public.submissions",
  "public.grade_reports",
  "storage.objects",
  "public.inventory_items",
].join("\n");

const DEFAULT_COUNTS = [
  "latest_migration|00782",
  "users|41",
  "submissions|193",
  "grade_reports|180",
  "storage_objects|2204",
  "rls_policies|401",
].join("\n");

let fakeBin = "";
let dumpFile = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "us3394-"));
  fakeBin = join(dir, "bin");
  mkdirSync(fakeBin);
  for (const [name, body] of [["pg_restore", FAKE_PG_RESTORE], ["psql", FAKE_PSQL]]) {
    const p = join(fakeBin, name);
    writeFileSync(p, body, { encoding: "utf8" });
    chmodSync(p, 0o755);
  }
  // A harmless stand-in for a dump. The script must reach its guard before it
  // ever reads this, and with the fakes in place it is never parsed.
  dumpFile = join(dir, "gradethread-20260911T020000Z.dump");
  writeFileSync(dumpFile, "not really a pg_dump archive\n");
});

/**
 * Run the real script end to end with the fakes on PATH.
 * Returns the exit status, the merged output, and every fake invocation.
 */
function runScript(target, env = {}) {
  const calls = join(mkdtempSync(join(tmpdir(), "us3394-calls-")), "calls.txt");
  const r = spawnSync(
    SHELL,
    [
      "-c",
      'PATH="$1:$PATH"; shift; exec bash "$@"',
      "sh",
      posixPath(fakeBin),
      posixPath(SCRIPT),
      posixPath(dumpFile),
      target,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        FAKE_CALLS: calls,
        FAKE_TOC: DEFAULT_TOC,
        FAKE_TABLES: DEFAULT_TABLES,
        FAKE_COUNTS: DEFAULT_COUNTS,
        RESTORE_CONFIRM_TARGET: "",
        ALLOW_PROD_RESTORE: "",
        SOURCE_DB_URL: "",
        RESTORE_ALLOW_EMPTY: "",
        ...env,
      },
    },
  );
  const log = existsSync(calls) ? readFileSync(calls, "utf8") : "";
  return {
    status: r.status,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    calls: log.split("\n").filter(Boolean),
  };
}

/** The destructive call: pg_restore without --list. */
function destructiveCalls(calls) {
  return calls.filter((c) => c.startsWith("pg_restore") && !c.includes("--list"));
}

// The DSN shape the repo documents for prod. This is the string the old guard
// was supposed to catch and could not.
const PROD_SHAPE = "postgres://postgres:hunter2@db-host:5432/postgres";
const PROD_FINGERPRINT = "db-host:5432/postgres";

describe("US-3394 AC2: the restore refuses every target until it is named back", () => {
  it("refuses a target that looks nothing like prod", () => {
    const r = runScript("postgres://postgres:pw@127.0.0.1:5432/scratch");
    expect(r.status).toBe(1);
    expect(destructiveCalls(r.calls)).toEqual([]);
    expect(r.out).toContain("refusing to restore");
  });

  it("refuses the DOCUMENTED PROD DSN, which the old substring guard let through", () => {
    // The whole story in one assertion. `postgres://...@db-host:5432/postgres`
    // contains no "gradethread.com", so the old arm never matched and the
    // restore ran unguarded.
    const r = runScript(PROD_SHAPE);
    expect(r.status).toBe(1);
    expect(destructiveCalls(r.calls)).toEqual([]);
    expect(r.out).toContain(PROD_FINGERPRINT);
  });

  it("does not let a mismatched confirmation through", () => {
    const r = runScript(PROD_SHAPE, { RESTORE_CONFIRM_TARGET: "127.0.0.1:5432/scratch" });
    expect(r.status).toBe(1);
    expect(destructiveCalls(r.calls)).toEqual([]);
    expect(r.out).toContain("Those do not match");
  });

  it("does not accept ALLOW_PROD_RESTORE=1 any more, and says so", () => {
    const r = runScript(PROD_SHAPE, { ALLOW_PROD_RESTORE: "1" });
    expect(r.status).toBe(1);
    expect(destructiveCalls(r.calls)).toEqual([]);
    expect(r.out).toContain("ALLOW_PROD_RESTORE is set and is no longer read");
  });

  it("prints a confirmation line that actually works when pasted back", () => {
    const refusal = runScript(PROD_SHAPE);
    const match = /RESTORE_CONFIRM_TARGET='([^']+)'/.exec(refusal.out);
    expect(match, "the refusal must show the string to confirm with").not.toBeNull();

    const accepted = runScript(PROD_SHAPE, { RESTORE_CONFIRM_TARGET: match[1] });
    expect(accepted.out).toContain("target confirmed");
    expect(destructiveCalls(accepted.calls).length).toBe(1);
    expect(accepted.status).toBe(0);
  });

  it("never puts the password in the string the operator has to copy", () => {
    const r = runScript(PROD_SHAPE);
    expect(r.out).not.toContain("hunter2");
  });

  it("refuses before touching anything, even with an unreadable dump", () => {
    // The order matters: the guard is upstream of pg_restore --list, so a
    // garbage dump cannot smuggle a restore past it.
    const r = runScript("postgres://u:p@127.0.0.1:5432/scratch");
    expect(r.calls).toEqual([]);
    expect(r.status).toBe(1);
  });
});

describe("US-3394 AC3: pg_restore's failure is not swallowed", () => {
  const confirmed = { RESTORE_CONFIRM_TARGET: PROD_FINGERPRINT };

  it("fails when pg_restore dies without reporting ignored errors", () => {
    const r = runScript(PROD_SHAPE, { ...confirmed, FAKE_RESTORE_RC: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("hard failure");
    expect(r.out).toContain("UNKNOWN state");
  });

  it("still passes when pg_restore ignored the Supabase scaffolding errors", () => {
    // This is why `|| true` was there. The distinction has to survive.
    const r = runScript(PROD_SHAPE, {
      ...confirmed,
      FAKE_RESTORE_RC: "1",
      FAKE_RESTORE_IGNORED: "7",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("ignored errors: 7");
    expect(r.out).toContain("PASS");
  });

  it("tells the two apart from the output, not from the exit code alone", () => {
    const hard = sourced('restore_ignored_errors "pg_restore: error: connection to server failed"');
    expect(hard.stdout.trim()).toBe("-1");

    const soft = sourced(
      'restore_ignored_errors "pg_restore: warning: errors ignored on restore: 12"',
    );
    expect(soft.stdout.trim()).toBe("12");
  });
});

describe("US-3394 AC4: the script compares the counts itself", () => {
  const confirmed = { RESTORE_CONFIRM_TARGET: PROD_FINGERPRINT };

  it("fails a restore that produced an empty table", () => {
    const r = runScript(PROD_SHAPE, {
      ...confirmed,
      FAKE_COUNTS: DEFAULT_COUNTS.replace("submissions|193", "submissions|0"),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL submissions: 0 rows");
  });

  it("fails when the migration table came back empty", () => {
    const r = runScript(PROD_SHAPE, {
      ...confirmed,
      FAKE_COUNTS: DEFAULT_COUNTS.replace("latest_migration|00782", "latest_migration|"),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL latest_migration");
  });

  it("fails when a table in the dump is missing from the restored database", () => {
    const r = runScript(PROD_SHAPE, {
      ...confirmed,
      FAKE_TABLES: DEFAULT_TABLES.split("\n").filter((t) => t !== "public.grade_reports").join("\n"),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("public.grade_reports");
    expect(r.out).toContain("are absent");
  });

  it("accepts a zero count only when it is opted into explicitly", () => {
    const r = runScript(PROD_SHAPE, {
      ...confirmed,
      RESTORE_ALLOW_EMPTY: "1",
      FAKE_COUNTS: DEFAULT_COUNTS.replace("submissions|193", "submissions|0"),
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("WARN submissions");
  });

  it("compares source and restored value-for-value when a source is given", () => {
    // `set -e` is live in a sourced shell, so the call has to be guarded the
    // same way the script itself guards it.
    const mismatch = sourced(
      'if compare_counts "users|41\nsubmissions|193" "users|41\nsubmissions|12"; then echo "rc=0"; else echo "rc=1"; fi',
    );
    expect(mismatch.stdout).toContain("FAIL submissions: source=193 restored=12");
    expect(mismatch.stdout).toContain("rc=1");

    const match = sourced(
      'if compare_counts "users|41" "users|41"; then echo "rc=0"; else echo "rc=1"; fi',
    );
    expect(match.stdout).toContain("rc=0");
  });

  it("does not report PASS when anything failed", () => {
    const r = runScript(PROD_SHAPE, {
      ...confirmed,
      FAKE_COUNTS: DEFAULT_COUNTS.replace("users|41", "users|0"),
    });
    expect(r.out).not.toContain("PASS");
    expect(r.out).toContain("Do NOT put it into service");
  });
});

describe("US-3394: the target fingerprint is credential-free and stable", () => {
  const cases = [
    ["postgres://postgres:pw@db-host:5432/postgres", "db-host:5432/postgres"],
    ["postgres://postgres:pw@db-host/postgres", "db-host:5432/postgres"],
    ["postgresql://u:p@10.0.0.5:6543/postgres?sslmode=require", "10.0.0.5:6543/postgres"],
    ["host=1.2.3.4 port=6543 dbname=postgres user=x", "1.2.3.4:6543/postgres"],
    ["postgres", "(local):5432/postgres"],
    ["postgresql://u:p@[::1]:5432/postgres", "[::1]:5432/postgres"],
  ];

  for (const [dsn, expected] of cases) {
    it(`${dsn} -> ${expected}`, () => {
      // Single-quoted in the snippet; none of the fixtures contain a quote.
      const r = sourced(`target_fingerprint '${dsn}'`);
      expect(r.stdout.trim()).toBe(expected);
    });
  }

  it("survives a password containing @ and /", () => {
    const r = sourced('target_fingerprint "postgres://u:p@ss/w@10.0.0.5:5432/postgres"');
    expect(r.stdout.trim()).toBe("10.0.0.5:5432/postgres");
  });

  it("reads tables out of a pg_restore TOC without picking up TABLE DATA twice", () => {
    const r = sourced('printf "%s\\n" "$FAKE_TOC" | toc_tables_from_list', { FAKE_TOC: DEFAULT_TOC });
    const lines = r.stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toEqual([
      "public.grade_reports",
      "public.submissions",
      "public.users",
      "storage.objects",
    ]);
  });
});
