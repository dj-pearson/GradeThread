#!/usr/bin/env node
// US-2670 -- prove the disputes INSERT policies check who owns the grade report.
//
// WHY THIS EXISTS BESIDE THE TENANT-ISOLATION CASE. That case goes at PostgREST
// as user B and is the right shape, but it needs the full local stack plus a
// seeded fixture env, so it runs almost never. This needs a Postgres carrying
// the migrations and nothing else. A security property nobody can check from a
// laptop is a security property nobody checks.
//
// IT ASSERTS BOTH DIRECTIONS. A policy that refused every insert would satisfy
// "the foreign one is refused" on its own, and would silently break every real
// dispute. The fixture files as A too, and this fails if that stops working.
//
// Usage:
//   node scripts/check-dispute-report-ownership.mjs --dsn "postgresql://..."
//   node scripts/check-dispute-report-ownership.mjs                  # docker
//   node scripts/check-dispute-report-ownership.mjs --container my_db
//
// Writes nothing: the fixture runs inside a transaction that rolls back.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const container = at("--container") ?? "supabase_db_gradethread";
const dsn = at("--dsn") ?? process.env.SKU_CHECK_DSN ?? process.env.DISPUTE_CHECK_DSN;
const psql = dsn
  ? {
    cmd: "psql",
    argv: [dsn, "-v", "ON_ERROR_STOP=0", "-f", "-"],
    how: `psql against ${dsn}`,
    hint: "Check the connection string, and that the server is up.",
  }
  : {
    cmd: "docker",
    argv: ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres"],
    how: `Postgres in container "${container}"`,
    hint: `Start it with: docker start ${container}\n  ` +
      `Or point this at any Postgres carrying the migrations: --dsn "postgresql://..."`,
  };

const fixture = join(HERE, "fixtures", "dispute-report-ownership.sql");
if (!existsSync(fixture)) {
  console.error(`✗ fixture missing: ${fixture}`);
  process.exit(1);
}

// ⚠ psql prints RAISE NOTICE on STDERR, so stdout alone carries none of the
// answer. Reading only stdout made this report "nothing was proved" against a
// database that had just proved it. spawnSync, and both streams.
const run = spawnSync(psql.cmd, psql.argv, {
  input: readFileSync(fixture, "utf8"),
  encoding: "utf8",
});
const out = String(run.stdout ?? "") + String(run.stderr ?? "");
if (!/RESULT /.test(out)) {
  console.error(
    `✗ could not reach ${psql.how}, or it answered nothing.\n  ${psql.hint}\n  ` +
      (out.split("\n").find(Boolean) ?? run.error?.message ?? "no output"),
  );
  process.exit(2);
}

const read = (name) => {
  const m = new RegExp(`RESULT ${name}=(\\S+)`).exec(out);
  return m ? m[1] : null;
};
const foreign = read("foreign_insert");
const own = read("own_insert");

if (foreign === null || own === null) {
  console.error(
    "✗ the fixture printed no RESULT line, so nothing was proved. Raw tail:\n" +
      out.slice(-1200),
  );
  process.exit(1);
}

console.log(`  B files against A's report   ${foreign}`);
console.log(`  A files against A's report   ${own}`);

const problems = [];
if (!foreign.startsWith("REFUSED")) {
  problems.push(
    "a seller can file a dispute against ANOTHER seller's grade report. Both " +
      "INSERT policies on public.disputes must carry " +
      "grade_report_belongs_to(grade_report_id, user_id) — that is migration 00624.",
  );
}
if (own !== "ALLOWED") {
  problems.push(
    "a seller can no longer dispute their OWN grade report. The ownership check " +
      "is too tight, and every real dispute is broken.",
  );
}

if (problems.length > 0) {
  for (const p of problems) console.error(`\n✗ ${p}`);
  process.exit(1);
}

console.log(
  "\n✓ disputes INSERT: a foreign grade_report_id is refused by RLS, and a " +
    "seller's own report is still disputable.",
);
