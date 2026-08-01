#!/usr/bin/env node
// US-2177: inventory the `listings` table and find the columns nothing reads.
//
// `listings` started as 11 columns in 00002 and grew by ALTER TABLE across the
// migration set, one feature at a time. Nobody ever looked at the result as a
// whole, so "is this column still used?" had no answer short of grepping 50
// names by hand — which is why the answer was always "leave it".
//
// This script produces the evidence the story asks for BEFORE anything is
// dropped: every column, where it was added, and every place the codebase
// mentions it. A column with zero references outside its own DDL is a
// CANDIDATE for removal, never an automatic one — the reference scan is textual
// and cannot see a name built at runtime, or one that only ever appears in a
// `select("*")`. Read the report, then decide.
//
// Usage:
//   node scripts/audit-listings-columns.mjs            # human-readable report
//   node scripts/audit-listings-columns.mjs --json     # machine-readable

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "supabase", "migrations");

/** Source trees that could reference a column by name. */
const SCAN_ROOTS = [
  "src",
  "services/edge-functions/src",
  "functions",
  "ios",
  "android",
  "sdk",
  // Included so the report can tell "only the schema mentions this" apart from
  // "nothing mentions it at all".
  "supabase/migrations",
];
const SCAN_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".swift",
  ".kt",
  ".sql",
  ".json",
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "build") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXTS.has(extname(name))) out.push(full);
  }
  return out;
}

/**
 * Every column the migrations put on `listings`, with the file that added it.
 *
 * Two shapes appear in this repo and both are handled: the CREATE TABLE body in
 * 00002, and `ALTER TABLE ... ADD COLUMN [IF NOT EXISTS] <name>` — which shows
 * up both one-per-statement and as a comma-separated list under a single ALTER.
 */
function collectColumns() {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const columns = new Map(); // name -> { addedIn, kind }

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");

    // CREATE TABLE ... listings ( ... );
    const create = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?listings\s*\(([\s\S]*?)\n\);/i
      .exec(sql);
    if (create) {
      for (const line of (create[1] ?? "").split("\n")) {
        const m = /^\s{2,}([a-z_][a-z0-9_]*)\s+\S/i.exec(line);
        if (m && !/^(primary|foreign|unique|check|constraint)$/i.test(m[1])) {
          if (!columns.has(m[1])) columns.set(m[1], { addedIn: file, kind: "base" });
        }
      }
    }

    // ALTER TABLE ... listings <body> up to the terminating semicolon.
    const alterRe = /ALTER TABLE (?:ONLY )?(?:public\.)?listings\b([\s\S]*?);/gi;
    let a;
    while ((a = alterRe.exec(sql)) !== null) {
      const body = a[1] ?? "";
      const addRe = /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
      let c;
      while ((c = addRe.exec(body)) !== null) {
        if (!columns.has(c[1])) columns.set(c[1], { addedIn: file, kind: "added" });
      }
    }
  }
  return columns;
}

/**
 * Count references to a column name outside the migration that added it.
 *
 * Word-boundary matched, so `notes` does not match `buyer_notes`. Migration
 * files are counted separately: a name that appears ONLY in SQL is schema that
 * no application code has ever read.
 */
function countReferences(columns, files) {
  const counts = new Map();
  for (const name of columns.keys()) counts.set(name, { code: 0, strict: 0, sql: 0, files: [] });

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = file.slice(ROOT.length + 1);
    const isSql = rel.startsWith("supabase/migrations");
    for (const name of columns.keys()) {
      // Cheap pre-filter before the regexes — most files mention most names
      // zero times and this runs ~70 names over a few thousand files.
      if (!text.includes(name)) continue;
      const loose = (text.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
      if (loose === 0) continue;
      const entry = counts.get(name);
      if (isSql) {
        entry.sql += loose;
        continue;
      }
      entry.code += loose;
      // COLUMN-SHAPED occurrences only: a quoted name (a select list, an .eq()
      // filter, a JSON key) or an object property key. This is the signal —
      // `views` and `watchers` are ordinary English and the loose count for
      // them is mostly prose, which would read as "heavily used" and stop
      // anyone from ever looking.
      entry.strict += (text.match(
        new RegExp(`["'\`]${name}["'\`]|\\b${name}\\s*:`, "g"),
      ) ?? []).length;
      if (entry.files.length < 4) entry.files.push(rel);
    }
  }
  return counts;
}

/**
 * Bucket a column by what it serves. Prefix and name based, deliberately —
 * the point is a first-pass classification a human then corrects, not an
 * authority.
 */
function classify(name) {
  if (/^(id|inventory_item_id|platform|listing_price|listed_at|is_active|notes|created_at|updated_at|listing_status|listing_url|platform_listing_id)$/.test(name)) {
    return "core lifecycle";
  }
  if (/^(ebay_|platform_offer_id|platform_category_id|synced_to_ebay_at|publish_error|aspect_review|quality_)/.test(name)) {
    return "ebay-specific";
  }
  if (/(cross|group|batch_id|listing_origin|scheduled_publish_at|promo_)/.test(name)) {
    return "cross-listing / automation";
  }
  if (/(views|watchers|impressions|click_through|metrics|price_range|_score$)/.test(name)) {
    return "metrics";
  }
  return "other";
}

const columns = collectColumns();
const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));
const counts = countReferences(columns, files);

const rows = [...columns.entries()]
  .map(([name, meta]) => ({
    name,
    ...meta,
    group: classify(name),
    code: counts.get(name).code,
    strict: counts.get(name).strict,
    sql: counts.get(name).sql,
    sample: counts.get(name).files,
  }))
  .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

// Two bars, on purpose. `code === 0` is the SAFE one — nothing anywhere spells
// the name, so a drop is defensible. `strict === 0` with a non-zero loose count
// means every hit was prose or an unrelated identifier, which is worth a human
// look but is NOT evidence on its own.
const unreferenced = rows.filter((r) => r.code === 0);
const looseOnly = rows.filter((r) => r.code > 0 && r.strict === 0);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total: rows.length, rows, unreferenced, looseOnly }, null, 2));
} else {
  console.log(`listings: ${rows.length} columns across ${new Set(rows.map((r) => r.addedIn)).size} migrations\n`);
  let group = "";
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      console.log(`\n── ${group} ──`);
    }
    const flag = r.code === 0 ? "  ← no code reference" : "";
    console.log(
      `  ${r.name.padEnd(30)} ${String(r.strict).padStart(4)} col  ${String(r.code).padStart(5)} loose  ${String(r.sql).padStart(3)} sql  (${r.addedIn})${flag}`,
    );
  }
  console.log(
    `\n${unreferenced.length} column(s) with NO reference in application code.`,
  );
  if (unreferenced.length > 0) {
    console.log("These are CANDIDATES, not verdicts — the scan is textual and");
    console.log("cannot see a name built at runtime or hidden behind select(\"*\").");
    for (const r of unreferenced) console.log(`  - ${r.name} (${r.addedIn})`);
  }
  if (looseOnly.length > 0) {
    console.log(
      `\n${looseOnly.length} column(s) whose every hit was prose, not a column reference:`,
    );
    for (const r of looseOnly) console.log(`  - ${r.name} (${r.addedIn})`);
  }
}
