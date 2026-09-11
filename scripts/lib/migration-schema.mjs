// The schema, read out of supabase/migrations/ with no database.
//
// US-3377. This is the shared half of the two guards US-3363 and US-3365 built
// for the edge service, lifted so the web app can use the same derivation:
//
//   - which columns a table really has        (columnsOf)
//   - which unique indexes are PARTIAL        (allUniqueIndexes)
//   - which users columns are self-service    (usersSelfServiceAllowlist)
//
// All three are DERIVED. A hard-coded copy of any of them is the exact failure
// these guards exist to prevent: it goes stale silently, and a stale
// expectation reports health.
//
// Deliberately plain ESM over `node:` builtins so the same file loads under
// Node (vitest), under Deno (the edge suite) and from a bare `node -e`. The
// edge still carries its own copy at
// services/edge-functions/src/tests/_migration-columns.ts; collapsing that onto
// this file is a mechanical follow-up that US-3377 was fenced out of.
//
// !! THE FILENAME FILTER IS LOAD-BEARING. Three migrations are numbered with
// SIX digits (000355, 000375, 000385) and a `^\d{5}_` filter drops them
// silently. That cost a false positive on push_device_tokens.is_active while
// the edge copy was being written.
//
// !! COMMENTS ARE STRIPPED PER FILE, NEVER AFTER CONCATENATION. The first
// version of the edge's partial-index scan stripped comments from all 785
// migrations joined into one string, and a cron expression inside a string
// literal in 00371 -- `'0 */2 * * *'` -- closed a `/*` opened in some earlier
// file. The lazy block-comment match then blanked every line between the two.
// Measured: 85 unique indexes of which 34 partial, against 128 and 60 parsed
// per file. A third of the schema was invisible and nothing errored; the scan
// reported a clean codebase.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";

// fileURLToPath, not `new URL(...).pathname`: on Windows the latter yields a
// leading-slash path that is absolute there and RELATIVE on Linux.
const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "migrations",
);

/** Migration files, in apply order. `.sql.BLOCKED` is not one. */
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d{5,}_.*\.sql$/.test(n))
    .sort();
}

export function migrationFileCount() {
  return migrationFiles().length;
}

/** The raw text of one migration. */
export function readMigration(name) {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

/**
 * Strip `--` line comments and block comments from ONE migration file.
 *
 * `--` first, so a `/*` living inside a line comment cannot open a block.
 */
export function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

let SQL = null;

/** Every migration, comment-stripped per file, then joined in apply order. */
function allSql() {
  if (SQL === null) {
    SQL = migrationFiles()
      .map((f) => stripSqlComments(readMigration(f)))
      .join("\n");
  }
  return SQL;
}

/** Table-level constraint keywords: they start a definition but are not columns. */
const NOT_A_COLUMN = new Set([
  "primary",
  "foreign",
  "unique",
  "check",
  "constraint",
  "exclude",
  "like",
]);

const columnCache = new Map();

/**
 * Every column a table holds: its CREATE TABLE list plus every ADD COLUMN and
 * the new name of every RENAME COLUMN.
 *
 * Deliberately one-directional in its permissiveness. A column this invents
 * makes a caller MISS a bad write; a column it misses makes a caller cry wolf
 * at correct code, which is the more expensive failure. The edge copy was
 * cross-checked against the live local stack on 2026-09-11 (782 migrations, 360
 * public base tables) and missed ZERO real columns.
 *
 * Returns an EMPTY set for a name it cannot resolve -- a view, or a table
 * declared in a shape this does not parse. Empty means "cannot check", which a
 * caller must never treat as "clean".
 */
export function columnsOf(table) {
  const hit = columnCache.get(table);
  if (hit) return hit;

  const sql = allSql();
  const out = new Set();

  const created = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${table}\\s*\\(`,
    "i",
  ).exec(sql);
  if (created) {
    const open = sql.indexOf("(", created.index);
    let depth = 0;
    let end = open;
    for (let i = open; i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    let nested = 0;
    let current = "";
    const parts = [];
    for (const ch of sql.slice(open + 1, end)) {
      if (ch === "(") nested++;
      if (ch === ")") nested--;
      if (ch === "," && nested === 0) {
        parts.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    parts.push(current);
    for (const part of parts) {
      const name = /^\s*"?([a-z_][a-z0-9_]*)"?/i.exec(part)?.[1]?.toLowerCase();
      if (!name || NOT_A_COLUMN.has(name)) continue;
      out.add(name);
    }
  }

  const alters = new RegExp(
    `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(?:public\\.)?${table}\\b([^;]*);`,
    "gis",
  );
  for (const m of sql.matchAll(alters)) {
    const body = m[1] ?? "";
    const added = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
    for (const c of body.matchAll(added)) out.add(c[1].toLowerCase());
    const renamed =
      /RENAME\s+COLUMN\s+"?([a-z_][a-z0-9_]*)"?\s+TO\s+"?([a-z_][a-z0-9_]*)"?/gi;
    for (const c of body.matchAll(renamed)) out.add(c[2].toLowerCase());
  }

  columnCache.set(table, out);
  return out;
}

/** Every name the migrations declare as a VIEW or MATERIALIZED VIEW. */
export function viewNames() {
  const out = new Set();
  const re =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const m of allSql().matchAll(re)) out.add(m[1].toLowerCase());
  return out;
}

/**
 * Every `CREATE UNIQUE INDEX` in one migration body.
 *
 * Deliberately narrow: CREATE UNIQUE INDEX only, not inline `UNIQUE` column
 * constraints and not `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE`. Postgres has
 * no syntax for a partial table constraint, so neither of those can produce the
 * defect, and the rule only fires on a target that MATCHES a partial index --
 * missing a non-partial constraint here can never turn into a false failure.
 */
export function parseUniqueIndexes(sql) {
  const out = [];
  const re =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)\s+ON\s+(?:ONLY\s+)?([a-z0-9_."]+)\s*(?:USING\s+\w+\s*)?\(([^;]*?)\)\s*([^;]*);/gis;
  for (const m of stripSqlComments(sql).matchAll(re)) {
    const name = m[1].replace(/"/g, "").split(".").pop().toLowerCase();
    const table = m[2].replace(/"/g, "").split(".").pop().toLowerCase();
    const columns = m[3]
      .split(",")
      .map((c) =>
        c
          .trim()
          .replace(/"/g, "")
          // drop per-column modifiers: DESC, NULLS LAST, COLLATE, opclass
          .replace(/\s+(asc|desc|nulls\s+(first|last)|collate\s+\S+)\b/gi, "")
          .trim()
          .toLowerCase(),
      )
      .filter((c) => c.length > 0);
    out.push({ name, table, columns, partial: /\bWHERE\b/i.test(m[4] ?? "") });
  }
  return out;
}

let INDEXES = null;

/** Every unique index the migrations declare, parsed ONE FILE AT A TIME. */
export function allUniqueIndexes() {
  if (INDEXES === null) {
    INDEXES = [];
    for (const f of migrationFiles()) {
      INDEXES.push(...parseUniqueIndexes(readMigration(f)));
    }
  }
  return INDEXES;
}

const SELF_SERVICE_MARKER = "self_service constant text[] := ARRAY[";

/**
 * The migration file that currently DEFINES the users self-update allowlist.
 *
 * Highest-numbered file that declares the array wins, which is the order the
 * migrations apply in. Pinning a number is wrong in a way nothing shows until
 * someone legitimately extends the list: applied migrations are immutable, so a
 * new self-service column arrives as a `CREATE OR REPLACE` in a LATER file.
 */
export function usersGuardMigration() {
  const files = migrationFiles().filter((f) =>
    readMigration(f).includes(SELF_SERVICE_MARKER),
  );
  if (files.length === 0) {
    throw new Error(
      "no migration declares `self_service constant text[] := ARRAY[` -- the " +
        "users self-update guard moved or was renamed, and every caller of " +
        "usersSelfServiceAllowlist() is now asserting against nothing.",
    );
  }
  return files[files.length - 1];
}

/**
 * The columns an authenticated session may change on its own public.users row,
 * as the database will actually see them.
 *
 * Read out of the function body, because the function body IS the list -- there
 * is no way to append to it from outside, so extending it means restating the
 * whole array in a new migration. 00710 documents what happens when someone
 * restates it from the wrong ancestor: copying 00526 instead of 00671 would
 * have dropped eight columns and silently RE-ADDED business_phone and
 * ship_from_address, which 00671 removed on purpose because a browser write
 * would store plaintext over AES-256-GCM ciphertext.
 */
export function usersSelfServiceAllowlist() {
  return parseSelfServiceArray(readMigration(usersGuardMigration()), usersGuardMigration());
}

/**
 * The quoted names inside a `self_service constant text[] := ARRAY[...]`.
 *
 * Separated from the file lookup so a self-check can run the SAME extractor
 * over a fabricated body. A self-check that re-implements the extractor proves
 * nothing about the extractor.
 *
 * Comments are stripped first. The ones inside 00710's array name columns in
 * prose ("business_phone and ship_from_address are NO LONGER HERE"), unquoted
 * today, and a future comment that quotes one would otherwise smuggle it back
 * into the list.
 */
export function parseSelfServiceArray(sql, label = "<inline>") {
  const start = sql.indexOf(SELF_SERVICE_MARKER);
  if (start === -1) throw new Error(`${label}: no self_service array here`);
  const end = sql.indexOf("];", start);
  if (end === -1) {
    throw new Error(`${label}: the self_service array is not terminated by "];"`);
  }
  const body = stripSqlComments(sql.slice(start, end));
  return [...body.matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]);
}
