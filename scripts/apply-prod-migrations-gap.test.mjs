// US-3395: the gap test for scripts/apply-prod-migrations.sh.
//
// ── THE DEFECT THIS IS FOR ───────────────────────────────────────────────────
// The script used to decide what was pending with
// `[[ "$prefix" > "$current" ]] || continue`, a comparison against the HIGHEST
// recorded version. Every file at or below that maximum was skipped, so a HOLE
// below the maximum was never applied. That is how `listings.draft_id` from
// 00134 stayed missing in production for months while every version above it
// sat recorded in `applied_migrations` (US-2726, US-2832). Nothing covered it.
//
// The second defect, same file: the version lookup ended in
// `2>/dev/null || echo "00000"`, so a refused connection or a denied SELECT
// became "this database is empty, apply all 645 files" with the reason thrown
// away. Measured on a scratch database 2026-09-11: against a reachable database
// whose lookup merely failed on privileges, the old script printed
// `current recorded version: 00000` and began replaying from 00001.
//
// ── WHY THIS RUNS AGAINST A REAL DATABASE ────────────────────────────────────
// The bug was never visible in the source text alone; it was visible in which
// files psql actually received. So the load-bearing cases below create a
// throwaway database, seed it into the exact shape that shipped (00001 and
// 00003 recorded, 00002 missing), run the real script, and then ASK THE
// DATABASE whether the gap migration's object exists. The database is created
// and dropped by this file and is never the project's own.
//
// Those cases need psql plus a reachable Postgres, so they SKIP where neither
// exists. A skip is loud on purpose: see `skipReason` in the output. The
// source-level cases below them always run, and are the floor, not the proof.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "apply-prod-migrations.sh");

// The local `supabase db start` stack, which is what every other db-touching
// lane in this repo assumes. Override to point the test somewhere else. These
// are the CLI's published local defaults, not a credential.
const ADMIN_URL =
  process.env.MIGRATION_GAP_TEST_DB_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";

const DB_NAME = `us3395_gap_${process.pid}`;
const TARGET_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`);

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

function psql(url, args, { allowFailure = false } = {}) {
  const r = spawnSync("psql", [url, "-tAX", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!allowFailure && r.status !== 0) throw new Error(`psql failed (${r.status}):\n${out}`);
  return { status: r.status, out };
}

function runScript(env) {
  const r = spawnSync("bash", [SCRIPT], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function haveBinary(name) {
  const r = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 20_000 });
  return r.status === 0;
}

let skipReason = null;
if (!haveBinary("psql")) skipReason = "psql is not on PATH";
else if (!haveBinary("bash")) skipReason = "bash is not on PATH";
else {
  const probe = psql(ADMIN_URL, ["-c", "select 1;"], { allowFailure: true });
  if (probe.status !== 0) {
    skipReason = `no Postgres at the test URL (run \`supabase db start\`, or set MIGRATION_GAP_TEST_DB_URL): ${probe.out.trim().split("\n")[0]}`;
  }
}
if (skipReason) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[US-3395] SKIPPING the real-database gap cases: ${skipReason}.\n` +
      "          The source-level cases still run, but they are a floor, not the proof.\n",
  );
}

// Three fixture migrations. Each is idempotent and self-records, like the real
// ones. 00002 is the hole.
const FIXTURES = {
  "00001_first.sql": [
    "CREATE TABLE IF NOT EXISTS public.applied_migrations (version text primary key, applied_at timestamptz default now());",
    "CREATE TABLE IF NOT EXISTS public.us3395_first (id int);",
    "INSERT INTO public.applied_migrations (version) VALUES ('00001') ON CONFLICT DO NOTHING;",
  ].join("\n"),
  "00002_gap.sql": [
    "CREATE TABLE IF NOT EXISTS public.us3395_gap (id int);",
    "INSERT INTO public.applied_migrations (version) VALUES ('00002') ON CONFLICT DO NOTHING;",
  ].join("\n"),
  "00003_third.sql": [
    "CREATE TABLE IF NOT EXISTS public.us3395_third (id int);",
    "INSERT INTO public.applied_migrations (version) VALUES ('00003') ON CONFLICT DO NOTHING;",
  ].join("\n"),
};

let fixtureDir = null;
// Roles are cluster-wide, not per-database, and a role holding GRANT CONNECT on
// a live database cannot be dropped. So they are cleaned up in afterAll, AFTER
// the database goes away, never inside the case that made them.
const createdRoles = [];

function recordedVersions() {
  return psql(TARGET_URL, ["-c", "select version from public.applied_migrations order by 1;"])
    .out.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function objectExists(name) {
  return psql(TARGET_URL, ["-c", `select to_regclass('public.${name}') is not null;`]).out.trim() === "t";
}

function resetDatabase() {
  psql(ADMIN_URL, ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`], { allowFailure: true });
  psql(ADMIN_URL, ["-c", `CREATE DATABASE ${DB_NAME};`]);
}

describe.skipIf(skipReason)("apply-prod-migrations.sh against a throwaway database", () => {
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "us3395-"));
    for (const [name, sql] of Object.entries(FIXTURES)) writeFileSync(join(fixtureDir, name), sql);
  });

  afterAll(() => {
    psql(ADMIN_URL, ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`], { allowFailure: true });
    for (const role of createdRoles) {
      psql(ADMIN_URL, ["-c", `DROP ROLE IF EXISTS ${role};`], { allowFailure: true });
    }
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("applies a migration sitting in a GAP below the highest recorded version", () => {
    resetDatabase();
    // The exact shape that shipped: 00001 and 00003 applied and recorded,
    // 00002 never applied. The maximum recorded version is 00003, so any
    // applier that compares against the maximum sees nothing to do.
    psql(TARGET_URL, ["-f", join(fixtureDir, "00001_first.sql")]);
    psql(TARGET_URL, ["-f", join(fixtureDir, "00003_third.sql")]);
    expect(recordedVersions()).toEqual(["00001", "00003"]);
    expect(objectExists("us3395_gap")).toBe(false);

    const run = runScript({ MIGRATIONS_DIR: fixtureDir, SUPABASE_DB_URL: TARGET_URL });
    expect(run.status, run.out).toBe(0);

    // The assertion that matters: the object from the hole is now in the
    // database, not merely that the script said something reassuring.
    expect(objectExists("us3395_gap"), run.out).toBe(true);
    expect(recordedVersions()).toEqual(["00001", "00002", "00003"]);
    expect(run.out).toMatch(/pending \(1\)/);
    expect(run.out).toMatch(/applying 00002_gap\.sql/);
  });

  it("applies nothing once every version is recorded, so it is still safe to re-run", () => {
    // Runs on the database the previous case left complete.
    const run = runScript({ MIGRATIONS_DIR: fixtureDir, SUPABASE_DB_URL: TARGET_URL });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toMatch(/nothing pending/);
    expect(run.out).not.toMatch(/applying /);
    expect(recordedVersions()).toEqual(["00001", "00002", "00003"]);
  });

  it("applies everything on a genuinely fresh database, where the tracker is absent", () => {
    resetDatabase();
    const run = runScript({ MIGRATIONS_DIR: fixtureDir, SUPABASE_DB_URL: TARGET_URL });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toMatch(/treating this database as FRESH/);
    expect(recordedVersions()).toEqual(["00001", "00002", "00003"]);
    expect(objectExists("us3395_gap")).toBe(true);
  });

  it("refuses when the version lookup fails on a REACHABLE database, rather than replaying everything", () => {
    resetDatabase();
    psql(TARGET_URL, ["-f", join(fixtureDir, "00001_first.sql")]);
    psql(TARGET_URL, ["-f", join(fixtureDir, "00003_third.sql")]);
    const role = `us3395_weak_${process.pid}`;
    createdRoles.push(role);
    psql(TARGET_URL, ["-c", `DROP ROLE IF EXISTS ${role};`], { allowFailure: true });
    psql(TARGET_URL, [
      "-c",
      `CREATE ROLE ${role} LOGIN PASSWORD 'notasecret'; ` +
        `GRANT CONNECT ON DATABASE ${DB_NAME} TO ${role}; ` +
        `GRANT USAGE, CREATE ON SCHEMA public TO ${role}; ` +
        `REVOKE ALL ON public.applied_migrations FROM ${role};`,
    ]);
    const weakUrl = TARGET_URL.replace("//postgres:postgres@", `//${role}:notasecret@`);
    const run = runScript({ MIGRATIONS_DIR: fixtureDir, SUPABASE_DB_URL: weakUrl });
    // A reachable database whose lookup fails is NOT a fresh database. The old
    // code called it 00000 and started applying from the first file.
    expect(run.status, run.out).not.toBe(0);
    expect(run.out).toMatch(/Refusing to guess/);
    expect(run.out).not.toMatch(/treating this database as FRESH/);
    expect(run.out).not.toMatch(/applying /);
    expect(objectExists("us3395_gap")).toBe(false);
  });
});

describe.skipIf(!haveBinary("psql"))("apply-prod-migrations.sh with no database at all", () => {
  it("exits non-zero and names the reason instead of defaulting to 00000", () => {
    const dead = "postgres://postgres:postgres@127.0.0.1:65431/postgres";
    const run = runScript({ SUPABASE_DB_URL: dead, MIGRATIONS_DIR: join(REPO, "supabase", "migrations") });
    expect(run.status).not.toBe(0);
    expect(run.out).toMatch(/Refusing to guess/);
    expect(run.out).not.toMatch(/00000/);
    expect(run.out).not.toMatch(/applying /);
  });
});

// ---------------------------------------------------------------------------
// the floor: source-level assertions that run everywhere, including CI without
// Docker or psql. These cannot prove the applier works; they can only stop the
// two specific defects being written back in.
// ---------------------------------------------------------------------------

describe("apply-prod-migrations.sh source", () => {
  const source = readFileSync(SCRIPT, "utf8");

  it("does not decide pending by comparing against the highest recorded version", () => {
    expect(source).not.toMatch(/\[\[\s*"\$prefix"\s*>\s*"\$current"\s*\]\]/);
    expect(source).not.toMatch(/latest_schema_migration\(\)\s*,\s*'00000'/);
  });

  it("decides pending by membership in applied_migrations", () => {
    expect(source).toMatch(/SELECT version FROM public\.applied_migrations/);
    expect(source).toMatch(/is_applied/);
  });

  it("never falls back to 00000 when the version lookup fails", () => {
    expect(source).not.toMatch(/\|\|\s*echo\s+"00000"/);
    expect(source).not.toMatch(/current="00000"/);
  });

  it("points the operator at the tool the runbook names", () => {
    expect(source).toMatch(/npm run migrate:prod/);
  });

  it("has unix line endings, because .gitattributes pins shell scripts to LF", () => {
    expect(source).not.toMatch(/\r/);
  });
});
