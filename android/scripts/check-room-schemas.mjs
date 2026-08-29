#!/usr/bin/env node
// US-2502: does every Room version have its exported schema committed?
//
// Room writes app/schemas/<db>/<version>.json at compile time. Two things need
// it, and both fail silently without it:
//
//   1. MigrationTestHelper. It replays a real database created at version N and
//      runs the migrations forward. With no N.json there is nothing to create,
//      so the test for that step cannot exist -- and a missing test looks
//      exactly like a passing one.
//   2. Review. The JSON diff is the only readable statement of what a migration
//      actually did to the schema.
//
// The export happens on YOUR machine when you bump the version. If the file is
// not committed in the same change it is gone: it cannot be regenerated later
// without checking out the old code and building it.
//
// That is not hypothetical here. Versions 3 and 4 were never committed (checked
// against the full history, not just the working tree), which is why the
// migration test starts at 5. KNOWN_GAPS records that so the check can be
// strict about everything else instead of being switched off.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const androidDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = join(
  androidDir,
  "app/src/main/java/com/gradethread/app/sync/db/GradeThreadDb.kt",
);
const schemaRoot = join(androidDir, "app/schemas");

// Historical, unrecoverable. Do NOT add to this list to make a failure go away:
// a version you are working on now CAN be exported, by building the module.
const KNOWN_GAPS = new Set([3, 4]);

const fail = (msg) => {
  console.error(`\x1b[31mroom schemas: ${msg}\x1b[0m`);
  process.exitCode = 1;
};

if (!existsSync(dbFile)) {
  fail(`cannot find ${dbFile}`);
  process.exit(1);
}

const src = readFileSync(dbFile, "utf8");

/**
 * The Room version, whether the annotation carries a literal or a const.
 *
 * US-2902: the annotation is now `version = GRADETHREAD_DB_VERSION`, because
 * `androidx.room.Database` is CLASS-retention and RoomMigrationTest could not
 * read it reflectively on a device — its `!!` threw an NPE in a companion
 * initializer and every case in that class had been failing on class load,
 * unnoticed, since it was written.
 *
 * So this resolves ONE level of indirection: a literal if the annotation has
 * one, otherwise the `const val` that names it, in the same file. Deliberately
 * one level and no further — a chain of consts is a Kotlin parser, and a guard
 * that quietly stops resolving is worse than one that says it cannot.
 */
function readDeclaredVersion(source) {
  const arg = source.match(/^\s*version\s*=\s*([A-Za-z0-9_]+)\s*,/m)?.[1];
  if (arg === undefined) return { error: "no `version = …` in the @Database annotation" };
  if (/^\d+$/.test(arg)) return { version: Number(arg) };
  const constant = source.match(
    new RegExp(`\\bconst\\s+val\\s+${arg}\\s*(?::\\s*Int\\s*)?=\\s*(\\d+)`),
  )?.[1];
  if (constant === undefined) {
    return {
      error:
        `version = ${arg}, but no \`const val ${arg} = <number>\` in the same file. ` +
        "Declare it there, or put a literal back in the annotation.",
    };
  }
  return { version: Number(constant) };
}

const declared = readDeclaredVersion(src);
if (declared.error) {
  fail(`could not read the Room version out of GradeThreadDb.kt — ${declared.error}`);
  process.exit(1);
}
const version = declared.version;

const dbDirs = existsSync(schemaRoot)
  ? readdirSync(schemaRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
  : [];
if (dbDirs.length !== 1) {
  fail(`expected exactly one database directory under app/schemas, found ${dbDirs.length}`);
  process.exit(1);
}
const dir = join(schemaRoot, dbDirs[0].name);
const present = new Set(
  readdirSync(dir)
    .map((f) => Number(f.replace(/\.json$/, "")))
    .filter(Number.isInteger),
);

const missing = [];
for (let v = 1; v <= version; v++) {
  if (!present.has(v) && !KNOWN_GAPS.has(v)) missing.push(v);
}

// The migrations declared in code, so a version bump with no migration is
// caught here rather than on a user's phone.
const migrations = new Set(
  [...src.matchAll(/Migration\((\d+),\s*(\d+)\)/g)].map((m) => `${m[1]}->${m[2]}`),
);
const missingMigrations = [];
for (let v = 1; v < version; v++) {
  if (!migrations.has(`${v}->${v + 1}`)) missingMigrations.push(`${v}->${v + 1}`);
}

if (missing.length) {
  fail(
    `database is at version ${version} but ${missing.map((v) => `${v}.json`).join(", ")} ` +
      "is not committed. Build the module (./gradlew :app:assembleDebug) and commit " +
      `app/schemas/${dbDirs[0].name}/.`,
  );
}
if (missingMigrations.length) {
  fail(
    `no Migration object for ${missingMigrations.join(", ")}. The database does not use ` +
      "fallbackToDestructiveMigration, so this crashes on launch for anyone who had the " +
      "previous version installed.",
  );
}

if (!process.exitCode) {
  const gaps = [...KNOWN_GAPS].filter((v) => v <= version && !present.has(v));
  console.log(
    `room schemas: version ${version}, ${present.size} exported, ` +
      `${migrations.size} migrations` +
      (gaps.length ? `  (known historical gap: ${gaps.join(", ")})` : ""),
  );
}
