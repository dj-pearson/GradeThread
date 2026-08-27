// Is a migration actually applied to production? Ask the database, not the file.
//
// PENDING_MIGRATIONS.md is a hand-edited marker, and it has gone stale in both
// directions: scripts/held-migration-gate.mjs exists because migrations reached
// origin while still marked HELD, and 00674 was the reverse - applied to prod
// while the file, the gate and the session-start hook all still called it HELD
// and BLOCKING. A marker maintained by hand is not evidence about a database.
//
// THE PROOF IS THE SELF-RECORD FOOTER, NOT THE SCHEMA. Every migration ends
// with `insert into public.applied_migrations (version) values ('NNNNN')`, and
// that is the LAST statement in the file. So a row for NNNNN means every
// statement above it ran. Checking instead that some column the migration adds
// now exists proves only that the migration got that far, which is exactly the
// mistake this script was written to stop repeating - a column shows up in
// PostgREST's OpenAPI document whether or not the CHECK constraint two
// statements later ever ran.
//
// READ-ONLY. It writes nothing.
//
//   deno run --allow-net --allow-env scripts/check-prod-migration.ts [00674 …]
//
// With no arguments it reports every migration file in the repo that prod has
// no record of. Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import { EXPECTED_SCHEMA_VERSION } from "../src/lib/schema-version.ts";

const url = Deno.env.get("SUPABASE_URL")?.trim();
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
// A key that is not header-safe fails per query rather than at connect time, so
// supabase-js reports it as "this table is unreadable" and a caller that treats
// an unreadable table as "no rows" prints a confident, wrong, empty answer.
const badChar = /[^\x21-\x7e]/.exec(key);
if (badChar || key.split(".").length !== 3 || key.length < 100) {
  console.error(
    `! SUPABASE_SERVICE_ROLE_KEY is not a usable JWT (${key.length} characters, ` +
      `${key.split(".").length} segments${
        badChar ? `, bad character at index ${badChar.index}` : ""
      }). Refusing to run rather than report a false negative.`,
  );
  Deno.exit(1);
}

// Migrations that are ABSENT FROM PROD ON PURPOSE. Without this, the sweep
// reports a permanent one-line gap that everybody learns to scroll past, which
// is how a real gap gets missed. Listed with the reason, so the exception is
// auditable rather than folklore.
const DELIBERATELY_UNAPPLIED: Record<string, string> = {
  "00527":
    "owner decision, permanent: its blanket REVOKE segfaults the DB on a denied " +
    "anon/authenticated call. US-2282's fix is a per-function authorization " +
    "check instead. Do not apply.",
};

const db = createClient(url, key, { auth: { persistSession: false } });

const { data, error } = await db.from("applied_migrations").select("version");
if (error) {
  console.error(`! applied_migrations unreadable: ${error.message}`);
  Deno.exit(1);
}
const applied = new Set(
  (data ?? []).map((r) => String((r as { version: string }).version)),
);
console.log(`${url} records ${applied.size} applied migration(s).`);
console.log(`this build expects EXPECTED_SCHEMA_VERSION = ${EXPECTED_SCHEMA_VERSION}`);

const asked = Deno.args.filter((a) => /^\d{5}$/.test(a));
if (asked.length > 0) {
  let missing = 0;
  for (const v of asked) {
    const ok = applied.has(v);
    if (!ok) missing += 1;
    console.log(`  ${ok ? "APPLIED" : "NOT APPLIED"}  ${v}`);
  }
  Deno.exit(missing > 0 ? 1 : 0);
}

// No arguments: everything in the repo that prod has no record of.
//
// Resolved from import.meta.url so it does not depend on the working directory,
// and handed to Deno.readDir as a URL rather than converted to a string.
// `new URL(...).pathname` is the trap here: it keeps a leading slash before the
// drive letter on Windows and produces a different shape on Linux, so the
// hand-rolled conversion works on the machine you wrote it on and fails in CI.
// Deno's filesystem APIs take a URL directly, so there is nothing to convert.
const migrationsDir = new URL("../../../supabase/migrations/", import.meta.url);
const files: string[] = [];
for await (const entry of Deno.readDir(migrationsDir)) {
  const m = /^(\d{5})_/.exec(entry.name);
  if (entry.isFile && m?.[1]) files.push(m[1]);
}
files.sort();
const gaps = files.filter((v) => !applied.has(v));
const real = gaps.filter((v) => !DELIBERATELY_UNAPPLIED[v]);
const expected = gaps.filter((v) => DELIBERATELY_UNAPPLIED[v]);
console.log(`${files.length} migration file(s) in ${migrationsDir}`);

for (const v of expected) {
  console.log(`  (expected gap) ${v} - ${DELIBERATELY_UNAPPLIED[v]}`);
}
if (real.length === 0) {
  console.log("prod has a record of every migration that is meant to be applied.");
  Deno.exit(0);
}
console.log(`
${real.length} NOT recorded on prod:`);
for (const v of real) console.log(`  ${v}`);
Deno.exit(1);
