#!/usr/bin/env node
// US-2804: every column named in a supabase .select("a, b, c") must exist on
// that table.
//
// I started this expecting a SILENT NULL — a missing column reading as
// undefined. It is worse than that: PostgREST answers 42703 and the WHOLE query
// fails, so the route or page never worked at all. Seven were found on the
// first run and every one had been broken since the day it was written.
//
// Two of the seven were US-268 ownership checks. Those FAIL CLOSED, which is the
// only luck in this: the check errored instead of passing, so no foreign row was
// ever reachable. The routes were dead, not open.
//
// WHY NOTHING CAUGHT THEM. `tsc -b` cannot: supabase-js types resolve to `never`
// under it, so the repo casts with `as Array<{...}>`, and a cast asserts whatever
// shape you write. Tests cannot either — the closest one to a finding here is
// source-structural, asserting the route's TEXT contains the endpoint, which it
// does. Only the schema knows, and nothing was reading the schema.
//
// Schema is reconstructed from supabase/migrations/*.sql, the only source
// available offline. That makes it wrong in one direction: a column the parser
// misses reads as a finding. Hand-check before believing it — see the note on
// the ALTER TABLE loop, which reported 523 false findings before it was fixed.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const R = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Build table -> columns from the migrations ──────────────────────────────
const migDir = join(R, "supabase/migrations");
const sql = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(migDir, f), "utf8")).join("\n");

const clean = sql.replace(/--[^\n]*/g, "");
const cols = new Map(); // table -> Set(col)
const add = (t, c) => {
  const k = t.replace(/^public\./, "").replace(/"/g, "").toLowerCase();
  if (!cols.has(k)) cols.set(k, new Set());
  cols.get(k).add(c.replace(/"/g, "").toLowerCase());
};

// CREATE TABLE [IF NOT EXISTS] name ( ... )
for (const m of clean.matchAll(
  /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(([\s\S]*?)\n\s*\);/gi,
)) {
  const body = m[2];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || /^(constraint|primary\s+key|unique|foreign\s+key|check|exclude)\b/i.test(t)) continue;
    const c = /^("?[a-z_][a-z0-9_]*"?)\s+/i.exec(t);
    if (c) add(m[1], c[1]);
  }
}
// ALTER TABLE ... ADD COLUMN [IF NOT EXISTS] name, ADD COLUMN ... , ADD COLUMN ...
//
// ⚠ THE FIRST VERSION TOOK ONE COLUMN PER STATEMENT and reported 523 findings,
// of which the two spot-checked were both real columns. A single ALTER TABLE in
// this repo routinely adds a dozen, so the parser has to walk the WHOLE
// statement (to the terminating semicolon) rather than match once.
for (const m of clean.matchAll(
  /alter\s+table\s+(?:if\s+exists\s+)?([\w."]+)([\s\S]*?);/gi,
)) {
  const table = m[1];
  for (const c of m[2].matchAll(
    /add\s+column\s+(?:if\s+not\s+exists\s+)?("?[a-z_][a-z0-9_]*"?)/gi,
  )) add(table, c[1]);
}
// CREATE VIEW name AS ... — treat as unknown (selects on views are common).
const views = new Set(
  [...clean.matchAll(/create\s+(?:or\s+replace\s+)?view\s+([\w."]+)/gi)]
    .map((m) => m[1].replace(/^public\./, "").replace(/"/g, "").toLowerCase()),
);
const matviews = new Set(
  [...clean.matchAll(/create\s+materialized\s+view\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi)]
    .map((m) => m[1].replace(/^public\./, "").replace(/"/g, "").toLowerCase()),
);


// ── Every .from("t")...select("...") in the edge + web ──────────────────────
function walk(dir, re, out = []) {
  let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (["node_modules", "dist", ".git", "coverage"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}
const files = [
  ...walk(join(R, "services/edge-functions/src"), /\.ts$/),
  ...walk(join(R, "src"), /\.(ts|tsx)$/),
].filter((p) => !/__tests__|[\\/]tests?[\\/]|\.test\.|_test\./.test(p));

const FROM_SELECT = /\.from\(\s*["']([a-z0-9_]+)["']\s*\)\s*\n?\s*\.select\(\s*(["'])([^"']*)\2/g;

const findings = [];
let checked = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(FROM_SELECT)) {
    const table = m[1].toLowerCase();
    const list = m[3];
    if (list.includes("*") || list.includes("(")) continue;   // embeds/star: skip
    if (views.has(table) || matviews.has(table)) continue;    // view columns not modelled
    const known = cols.get(table);
    if (!known) continue;                                     // table not reconstructed
    for (const raw of list.split(",")) {
      const c = raw.trim().split(":")[0].trim().toLowerCase();
      if (!c || c.includes("!")) continue;
      checked++;
      if (!known.has(c)) {
        findings.push({ file: relative(R, f).replaceAll("\\", "/"), table, col: c });
      }
    }
  }
}

// ── The other query surfaces: .eq(), .order(), .in(), … ─────────────────────
//
// US-2805: .select() is not the only place a column name appears, and it is not
// even the place the next bug turned up. The admin AI-models page did
// `.select("*")` — which this file skips, correctly — and then ordered by a
// column that does not exist, so the page threw on load. A guard that only read
// select lists could never have seen it.
//
// Chained calls make attribution harder here: the table is on .from() and the
// filters follow, sometimes many lines later or through a reassigned builder
// variable. This tracks the most recent .from() per file and attributes filters
// to it until a blank line. That is an APPROXIMATION — it can mis-attribute in
// a file interleaving two builders — so a finding is a prompt to go and look,
// not a verdict. 4698 references produced exactly one, and it was real.
const FILTER = /\.(eq|neq|gt|gte|lt|lte|like|ilike|in|contains|order)\(\s*["']([a-z0-9_]+)["']/g;
const FROM_LINE = /\.from\(\s*["']([a-z0-9_]+)["']\s*\)/;

for (const f of files) {
  const lines = readFileSync(f, "utf8").replace(/\r\n?/g, "\n").split("\n");
  let table = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = FROM_LINE.exec(line);
    if (fm) table = fm[1].toLowerCase();
    if (!table) continue;
    if (/^\s*$/.test(line)) { table = null; continue; }
    const known = cols.get(table);
    if (!known || views.has(table) || matviews.has(table)) continue;
    for (const m of line.matchAll(FILTER)) {
      const c = m[2].toLowerCase();
      checked++;
      if (!known.has(c)) {
        findings.push({ file: relative(R, f).replaceAll("\\", "/"), table, col: c });
      }
    }
  }
}

// ── Writes: the object keys of .insert() / .update() / .upsert() ────────────
//
// The last surface, and it came back CLEAN on its first run — 3155 references,
// zero findings. It is folded in anyway, because the value of a guard is what
// it stops arriving, not what it found on the day it was written, and a wrong
// column in a WRITE is worse than in a read: the write fails and the caller
// usually reports a success-shaped nothing.
//
// TOP-LEVEL KEYS ONLY. A nested object is a jsonb VALUE, and its keys are not
// columns — counting them would flag every settings blob in the repo.
const WRITE = /\.from\(\s*["']([a-z0-9_]+)["']\s*\)\s*\n?\s*\.(?:insert|update|upsert)\(\s*\{/g;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(WRITE)) {
    const table = m[1].toLowerCase();
    const known = cols.get(table);
    if (!known || views.has(table) || matviews.has(table)) continue;
    let depth = 0, end = -1;
    const start = m.index + m[0].length - 1;
    for (let k = start; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}") { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) continue;
    let d = 0;
    for (const line of src.slice(start + 1, end).split("\n")) {
      const key = /^\s*([a-z_][a-z0-9_]*)\s*:/.exec(line);
      if (d === 0 && key) {
        checked++;
        if (!known.has(key[1].toLowerCase())) {
          findings.push({
            file: relative(R, f).replaceAll("\\", "/"), table, col: key[1].toLowerCase(),
          });
        }
      }
      for (const ch of line) {
        if (ch === "{" || ch === "[" || ch === "(") d++;
        else if (ch === "}" || ch === "]" || ch === ")") d--;
      }
    }
  }
}

const byKey = new Map();
for (const f of findings) {
  const k = `${f.table}.${f.col}`;
  if (!byKey.has(k)) byKey.set(k, new Set());
  byKey.get(k).add(f.file);
}

// GUARDS THE GUARD. A sabotage that broke the from().select() matcher left this
// reporting "OK 0 column reference(s)" — a clean pass because it had found
// nothing to check, which is the one way a scanner can be completely broken and
// completely green. These floors are well under the real numbers (5395 / 307)
// and exist only to make "found nothing" impossible to confuse with "found
// nothing wrong".
// Raised twice, and both raises were load-bearing rather than bookkeeping.
// 3000 -> 7000 when the filter surface arrived (5395 -> 9934): the sabotage
// that breaks the filter matcher leaves the select half's 5395 still flowing,
// so the old floor passed a guard with half its coverage gone. 7000 -> 11000
// when writes arrived (9934 -> 13089), for the same reason. A floor that lags
// the truth by a whole surface has quietly stopped guarding; keep it close
// enough that losing any ONE of the three trips it.
const MIN_REFS = 11000;
const MIN_TABLES = 200;
if (checked < MIN_REFS || cols.size < MIN_TABLES) {
  console.error(
    `\n[select-columns] the scan itself is broken: ${checked} reference(s) ` +
      `across ${cols.size} table(s), expected at least ${MIN_REFS} and ` +
      `${MIN_TABLES}.\n\n` +
      "  Something stopped matching — the .from().select() pattern, the\n" +
      "  migration parser, or the directory walk. Fix that before trusting a\n" +
      "  pass; a scanner that finds nothing reports the same OK as one that\n" +
      "  finds nothing wrong.\n",
  );
  process.exit(1);
}

if (findings.length === 0) {
  console.log(
    `[select-columns] OK  ${checked} column reference(s) against ${cols.size} table(s).`,
  );
  process.exit(0);
}

console.error(
  "\n[select-columns] a query names column(s) no migration declares:\n",
);
for (const [k, where] of [...byKey].sort()) {
  console.error(`    ${k}`);
  console.error(`        ${[...where].slice(0, 3).join(", ")}`);
}
console.error(
  "\n  This is NOT a type error and NOT a silent null. PostgREST answers 42703\n" +
    "  and the WHOLE query fails, so the route or page simply never worked. All\n" +
    "  seven of the first findings were exactly that, including two US-268\n" +
    "  ownership checks that had been answering 500 to every caller.\n" +
    "\n" +
    "  The usual cause is a hand-written `as Array<{...}>` cast. Those casts\n" +
    "  exist because supabase-js types resolve to `never` under `tsc -b`, and\n" +
    "  they assert a shape the database does not have — which is precisely what\n" +
    "  let all seven typecheck for as long as they did.\n" +
    "\n" +
    "  Check the name against supabase/migrations before renaming anything. The\n" +
    "  answer is often that it belongs to a VIEW rather than to the table being\n" +
    "  queried: `items_full.category` is COALESCE(item_category,\n" +
    "  garment_category) and `items_full.item_title` is inventory_items.title.\n" +
    "\n" +
    "  If this reports a column that DOES exist, the schema reconstruction missed\n" +
    "  it — fix the parser rather than the code. It once took one ADD COLUMN per\n" +
    "  ALTER TABLE and reported 523 findings, every one of them wrong.\n",
);
process.exit(1);
