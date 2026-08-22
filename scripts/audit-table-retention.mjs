#!/usr/bin/env node
// US-2644: which tables does anything ever DELETE from?
//
// WHY THIS EXISTS AS A SCRIPT RATHER THAN A ONE-OFF GREP. US-2643 needed an
// inventory of application tables with no retention sweep, and the throwaway
// scan written for it was WRONG in the dangerous direction: it reported
// `radar_scan_events` as never purged, when radar-aggregate-engine.ts deletes
// them in a helper the pattern could not see. A false "nothing purges this"
// invites building a sweep that already exists, and a false one about a
// PII-bearing table is worse — it turns into a privacy finding that is not real.
//
// THE FIX IS TO STOP GUESSING WHERE A CHAIN ENDS. A supabase-js call is one
// expression terminated by a semicolon:
//
//     const { error } = await supabaseAdmin
//       .from("radar_scan_events")
//       .delete()
//       .in("id", part);
//
// The earlier scan read a fixed 300-character window and a lookahead that cut
// the chain short. This reads from `.from("x")` to the next semicolon at the
// same nesting depth, which is where the statement actually ends.
//
// WHAT A "yes" AND A "no" EACH MEAN. A `yes` is evidence: this exact table is
// deleted from, at that file and line. A `no` is NOT proof of absence — a
// deletion could happen in SQL this does not read, in a trigger, or through a
// dynamically-built table name. So `no` is a QUESTION to check by hand, and the
// output says so rather than presenting itself as a finding.

// ── `--fk`: the third answer, added 2026-08-16 for US-2643 ──────────────────
// A table with no sweep is not automatically a table that grows forever. Ten of
// the 23 this tool reported as unswept are purged by ON DELETE CASCADE when the
// user goes, and six more survive with the user id nulled. Those are three
// different retention stories and the tool was collapsing them into one, which
// made its "no delete found" list read as 23 problems when it is 7.
//
// This reads pg_constraint rather than parsing the migration corpus, because
// deriving a foreign-key graph from 609 files of DDL by regex is precisely the
// guessing this tool exists to stop doing. It needs a database, so it is opt-in
// and the rest of the tool still runs without one.
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// US-2788: a docker call with no timeout hangs forever on a wedged daemon.
import { DOCKER_QUERY_MS } from "./lib/docker-timeout.mjs";
import { join, sep } from "node:path";

const REPO = process.cwd();

// `.delete()` AND `.delete({ count: "exact" })`. Requiring empty parens missed
// purgeExpiredGradingPii, which passes a count option — the second false
// negative in this tool, in the same direction as the first, and caught only by
// checking it against a delete I had already read by hand.
const DELETE_CALL = /\.delete\(/;
const EDGE = "services/edge-functions/src";
const MIGRATIONS = "supabase/migrations";

/** Tables declared by the migration corpus. */
export function declaredTables(sqlDir = MIGRATIONS, repo = REPO) {
  const out = new Set();
  for (const f of readdirSync(join(repo, sqlDir))) {
    if (!f.endsWith(".sql")) continue;
    const sql = readFileSync(join(repo, sqlDir, f), "utf8");
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+)/gi)) {
      out.add(m[1].toLowerCase());
    }
  }
  return out;
}

/**
 * The statement a `.from("table")` belongs to: from that call to the next
 * semicolon that is not inside a string, template literal, comment, or nested
 * parentheses/brackets.
 *
 * This is the whole correctness of the tool. A window that is too short misses
 * the `.delete()`; one that is too long attributes a neighbour's delete to this
 * table, which is the same lie in the other direction.
 */
export function statementAt(src, from) {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth <= 0) return src.slice(from, i + 1);
    i++;
  }
  return src.slice(from);
}

function skipString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return src.length;
}

function sourceFiles(root, repo = REPO) {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  })(join(repo, root));
  return out;
}

/** table -> [{ file, line }] where a delete is issued against it. */
export function deletedTables(root = EDGE, repo = REPO) {
  const found = new Map();
  for (const p of sourceFiles(root, repo)) {
    const rel = p.slice(repo.length + 1).split(sep).join("/");
    if (rel.includes("/tests/")) continue;
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/\.from\(\s*"([a-z0-9_]+)"\s*\)/g)) {
      const stmt = statementAt(src, m.index);
      if (!DELETE_CALL.test(stmt)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push({ file: rel, line });
    }
  }
  return found;
}

/** Tables a migration deletes from directly (functions, triggers, backfills). */
export function sqlDeletedTables(sqlDir = MIGRATIONS, repo = REPO) {
  const out = new Map();
  for (const f of readdirSync(join(repo, sqlDir))) {
    if (!f.endsWith(".sql")) continue;
    const sql = readFileSync(join(repo, sqlDir, f), "utf8");
    for (const m of sql.matchAll(/DELETE\s+FROM\s+(?:public\.)?([a-z0-9_]+)/gi)) {
      const t = m[1].toLowerCase();
      if (!out.has(t)) out.set(t, []);
      out.get(t).push({ file: `${sqlDir}/${f}` });
    }
  }
  return out;
}

/**
 * table -> [{ parent, onDelete }] read from pg_constraint.
 *
 * Uses RETENTION_DB_URL if set, otherwise the local throwaway stack's container.
 * Returns null — not an empty map — when no database is reachable, so the caller
 * can say "not checked" instead of printing an absence as an answer.
 */
export function foreignKeysFromCatalog(tables) {
  const sql =
    "SELECT c.conrelid::regclass::text, c.confrelid::regclass::text, " +
    "CASE c.confdeltype WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' " +
    "WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' " +
    "WHEN 'd' THEN 'set default' END " +
    "FROM pg_constraint c WHERE c.contype = 'f' ORDER BY 1, 2;";

  const url = process.env.RETENTION_DB_URL;
  const argv = url
    ? ["psql", url, "-tAF|", "-c", sql]
    : ["docker", "exec", "-i", "supabase_db_gradethread", "psql", "-U", "postgres",
       "-d", "postgres", "-tAF|", "-c", sql];

  let raw;
  try {
    // US-2788: bounded, so a wedged daemon reaches the catch below instead of
    // hanging here forever.
    raw = execFileSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: DOCKER_QUERY_MS,
    });
  } catch {
    return null;
  }

  return parseFkRows(raw, tables);
}

/**
 * The psql rows, split by table. Separate from the shell-out so it is testable
 * without a database — the schema-qualification rule below is the part that can
 * be silently wrong, and a wrong answer here reads as "no foreign key", which is
 * the same false-absence this whole tool was written to stop producing.
 */
export function parseFkRows(raw, tables) {
  const out = new Map();
  const wanted = new Set(tables);
  for (const line of raw.split("\n")) {
    const [child, parent, onDelete] = line.trim().split("|");
    if (!child || !parent || !onDelete) continue;
    // `conrelid::regclass` omits the schema for anything on the search_path, so
    // a public table arrives bare (`user_events`) while auth.users arrives
    // qualified (`auth.users`). Strip only the `public.` form: stripping every
    // schema would make an `auth`-schema child collide with a public table of
    // the same name.
    const bare = child.startsWith("public.") ? child.slice("public.".length) : child;
    if (!wanted.has(bare)) continue;
    if (!out.has(bare)) out.set(bare, []);
    out.get(bare).push({ parent, onDelete });
  }
  return out;
}

function main() {
  const declared = declaredTables();
  const edge = deletedTables();
  const sql = sqlDeletedTables();
  const onlyLogs = process.argv.includes("--logs");

  const isLoggy = (t) =>
    /(^|_)(log|logs|audit|event|events)$/.test(t) || /^(audit|ops|security)_/.test(t);

  const rows = [...declared]
    .filter((t) => (onlyLogs ? isLoggy(t) : true))
    .sort()
    .map((t) => ({ table: t, edge: edge.get(t) ?? [], sql: sql.get(t) ?? [] }));

  const swept = rows.filter((r) => r.edge.length || r.sql.length);
  const unswept = rows.filter((r) => !r.edge.length && !r.sql.length);

  console.log(
    `${declared.size} tables declared` +
      (onlyLogs ? `, ${rows.length} matching the log/audit/event shape` : "") +
      `\n${swept.length} have a delete this tool can see, ${unswept.length} do not.\n`,
  );

  console.log("── deleted somewhere (evidence) ──");
  for (const r of swept) {
    const where = r.edge.length
      ? `${r.edge[0].file}:${r.edge[0].line}${r.edge.length > 1 ? ` (+${r.edge.length - 1})` : ""}`
      : r.sql[0].file;
    console.log(`  ${r.table.padEnd(38)} ${where}`);
  }

  if (!process.argv.includes("--fk")) {
    console.log("\n── no delete found (a QUESTION, not a finding) ──");
    for (const r of unswept) console.log(`  ${r.table}`);
    console.log(
      "\nA `no` here means this tool saw no delete. It cannot see a trigger, a\n" +
        "database-side scheduled job, or a table name built at runtime. Check by\n" +
        "hand before concluding a table grows forever — the scan this replaces got\n" +
        "exactly that wrong about radar_scan_events.\n\n" +
        "Pass --fk to split that list by foreign key, which answers most of it.",
    );
    return;
  }

  const fks = foreignKeysFromCatalog(unswept.map((r) => r.table));
  if (!fks) {
    console.log(
      "\n── --fk needs a database and could not reach one ──\n" +
        "  Start the local stack (`npx supabase start`) or set RETENTION_DB_URL.\n" +
        "  Not printing an unchecked list as though it were checked.",
    );
    return;
  }

  const cascaded = [];
  const nulled = [];
  const orphaned = [];
  for (const r of unswept) {
    const links = fks.get(r.table) ?? [];
    const cascade = links.find((l) => l.onDelete === "cascade");
    if (cascade) cascaded.push({ ...r, via: cascade.parent });
    else if (links.some((l) => l.onDelete === "set null")) nulled.push(r);
    else orphaned.push(r);
  }

  console.log("\n── purged when the PARENT row goes (ON DELETE CASCADE) ──");
  console.log(
    "  ⚠ Only ONE of the two erasure paths deletes a user row. The formal\n" +
      "  compliance erasure ANONYMIZES and keeps it, so no cascade fires there.\n",
  );
  for (const r of cascaded) console.log(`  ${r.table.padEnd(38)} via ${r.via}`);

  console.log("\n── survives deletion, user id nulled (ON DELETE SET NULL) ──");
  for (const r of nulled) console.log(`  ${r.table}`);

  console.log("\n── no sweep and no owner link: grows without bound ──");
  for (const r of orphaned) console.log(`  ${r.table}`);
  console.log(
    "\nThis last list is the only one that is a finding on its own. The two above\n" +
      "it are retention stories, just not time-based ones — which is the question\n" +
      "a privacy page's '90 days' row is actually asking.",
  );
}

if (process.argv[1]?.endsWith("audit-table-retention.mjs")) main();
