// The real column list of every public table, read out of the migrations.
//
// US-3363. `flipdesk-sync.ts` patched `listings` with a `sold_at` the table has
// never had. PostgREST answers HTTP 400 PGRST204 for the whole statement, so
// `listing_status: "sold"` did not land either, and nothing read the result --
// an extension-confirmed sale booked a sales row and left its listing showing
// as live. It was found by accident a month later.
//
// A column list can only be wrong against a SCHEMA, which is why no unit test
// could see it. This module gives the schema to a test without a database:
// concatenate every migration in apply order and parse what each CREATE TABLE
// and ADD COLUMN declares. The expectation is therefore derived, not
// remembered -- renaming a column moves this with it instead of pinning
// today's spelling.
//
// MEASURED against the live local stack on 2026-09-11 (782 migrations applied,
// 360 public base tables): of every column information_schema reports, this
// parser missed ZERO, so it cannot cry wolf. Three columns go the other way --
// audience_segments.conditions, dashboard_layouts.widgets, drip_campaigns.steps
// are parsed but do not exist -- so those three names, and only those, could
// hide a bad write.
//
// !! THE FILENAME FILTER IS LOAD-BEARING. Three migrations are numbered with six
// digits (000355, 000375, 000385), and a `^\d{5}_` filter drops them silently.
// That cost a false positive on push_device_tokens.is_active while this was
// being written: the column is real, its CREATE TABLE just lives in 000375.
// `migrationFileCount()` exists so a suite can put a floor under the corpus
// rather than trusting the glob.

const MIGRATIONS_DIR = new URL(
  "../../../../supabase/migrations/",
  import.meta.url,
);

/** Migration files, in apply order. `.sql.BLOCKED` is not one. */
function migrationFiles(): string[] {
  return [...Deno.readDirSync(MIGRATIONS_DIR)]
    .filter((e) => e.isFile && /^\d{5,}_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

export function migrationFileCount(): number {
  return migrationFiles().length;
}

const SQL = migrationFiles()
  .map((f) => Deno.readTextFileSync(new URL(f, MIGRATIONS_DIR)))
  .join("\n")
  .replace(/--[^\n]*/g, "");

/** Table-level constraint keywords, which start a definition but are not columns. */
const NOT_A_COLUMN = new Set([
  "primary",
  "foreign",
  "unique",
  "check",
  "constraint",
  "exclude",
  "like",
]);

const cache = new Map<string, Set<string>>();

/**
 * Every column a table holds: its CREATE TABLE list plus every ADD COLUMN and
 * the new name of every RENAME COLUMN.
 *
 * Deliberately one-directional in its permissiveness. A column this invents
 * makes a guard MISS a bad write; a column it misses makes a guard cry wolf at
 * correct code, which is the more expensive failure (see mode 8 of
 * guards-that-do-not-guard). The cross-check above says the second number is
 * zero.
 *
 * Returns an EMPTY set for a name it cannot resolve -- a view, or a table
 * declared in a shape this does not parse. Empty means "cannot check", which a
 * caller must not confuse with "clean".
 */
export function columnsOf(table: string): Set<string> {
  const hit = cache.get(table);
  if (hit) return hit;

  const out = new Set<string>();

  const created = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${table}\\s*\\(`,
    "i",
  ).exec(SQL);
  if (created) {
    const open = SQL.indexOf("(", created.index);
    let depth = 0;
    let end = open;
    for (let i = open; i < SQL.length; i++) {
      if (SQL[i] === "(") depth++;
      else if (SQL[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    let nested = 0;
    let current = "";
    const parts: string[] = [];
    for (const ch of SQL.slice(open + 1, end)) {
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
  for (const m of SQL.matchAll(alters)) {
    const body = m[1] ?? "";
    const added = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
    for (const c of body.matchAll(added)) out.add(c[1]!.toLowerCase());
    const renamed =
      /RENAME\s+COLUMN\s+"?([a-z_][a-z0-9_]*)"?\s+TO\s+"?([a-z_][a-z0-9_]*)"?/gi;
    for (const c of body.matchAll(renamed)) out.add(c[2]!.toLowerCase());
  }

  cache.set(table, out);
  return out;
}

/** Every name the migrations declare as a VIEW or MATERIALIZED VIEW. */
export function viewNames(): Set<string> {
  const out = new Set<string>();
  const re =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const m of SQL.matchAll(re)) out.add(m[1]!.toLowerCase());
  return out;
}
