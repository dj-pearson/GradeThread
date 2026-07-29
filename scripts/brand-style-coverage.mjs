#!/usr/bin/env node
// US-2216: report brand_styles coverage, and rank the gaps by real volume.
//
// AC1 asks for coverage to be prioritized "by actual submission and listing
// volume per brand, not by KB seeding order — name the query that produced the
// priority list". This script IS that query, in both the forms it can take:
//
//   --db     joins brand_styles against inventory_items + submissions volume
//            (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; the only place
//            real volume exists). Prints brands ordered by items-we-actually-see
//            with their current style count.
//   default  static pass over supabase/migrations, for a sandbox or CI where no
//            database is reachable. Reports coverage only — it CANNOT rank by
//            volume, and says so rather than substituting seeding order, which
//            is the exact thing AC1 forbids.
//
// Usage:
//   node scripts/brand-style-coverage.mjs
//   node scripts/brand-style-coverage.mjs --db
//   node scripts/brand-style-coverage.mjs --json

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url).pathname;

/**
 * Count tuples inserted into a table across every migration. Parses the VALUES
 * body of each `insert into public.<table>` statement and reads the first
 * column of each tuple, which is `brand_key` for all four brand tables.
 *
 * Deliberately tolerant: the packs are hand-written across 40+ files with
 * varying formatting, and a parser that silently under-counts would produce
 * exactly the false "coverage is a fraction" reading this script exists to
 * correct. Statements it cannot parse are reported, never dropped quietly.
 */
export function countByBrand(sqlFiles, table) {
  const counts = new Map();
  let statements = 0;
  let unparsed = 0;

  // Segment each file at every `insert into public.<something>` and attribute
  // the tuple lines in a segment to the table that segment opened with.
  //
  // NOT a single statement-level regex ending at `;`: the packs embed
  // dollar-quoted JSON (authentication_tells, tag_eras) whose prose contains
  // semicolons, so a `;`-terminated match truncates the statement BEFORE its
  // VALUES tuples and silently reports zero rows. That is how a first pass here
  // under-counted brand_knowledge by 53 statements and produced a "brands with
  // no styles" list that was wrong.
  const opener = /insert\s+into\s+public\.([a-z_]+)\b/gi;
  for (const { name, text } of sqlFiles) {
    const opens = [...text.matchAll(opener)];
    for (let i = 0; i < opens.length; i++) {
      if (opens[i][1].toLowerCase() !== table) continue;
      statements++;
      const from = opens[i].index;
      const to = i + 1 < opens.length ? opens[i + 1].index : text.length;
      const body = text.slice(from, to);
      // Three tuple forms occur across the packs, and missing any of them
      // silently under-counts a brand into the "no styles" list:
      //   (a) one tuple per line          ->   ('zara', 'Zara', ...
      //   (b) tuple on the values line    ->  values ('nike', 'Nike', ...
      //   (c) tuple opened, key next line ->  values (\n  'lululemon', ...
      const tuples = [
        ...body.matchAll(/(?:^[ \t]*|\bvalues[ \t]*)\(\s*'([a-z0-9_]+)'/gim),
      ];
      if (tuples.length === 0) {
        unparsed++;
        continue;
      }
      for (const t of tuples) {
        const key = t[1];
        if (!counts.has(key)) counts.set(key, { count: 0, files: new Set() });
        const e = counts.get(key);
        e.count++;
        e.files.add(name);
      }
    }
  }
  return { counts, statements, unparsed };
}

export function loadMigrations() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(MIGRATIONS, name), "utf8") }));
}

/** Brands that appear in brand_knowledge but have zero brand_styles rows. */
export function styleGaps(sqlFiles) {
  const kb = countByBrand(sqlFiles, "brand_knowledge");
  const st = countByBrand(sqlFiles, "brand_styles");
  const missing = [...kb.counts.keys()].filter((k) => !st.counts.has(k)).sort();
  const thin = [...st.counts.entries()]
    .filter(([k, v]) => kb.counts.has(k) && v.count <= 1)
    .map(([k]) => k)
    .sort();
  return { kb, st, missing, thin };
}

async function volumeFromDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "--db needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Volume lives only in the database; there is no offline substitute.",
    );
  }
  // Two reads, both brand-only — no tenant rows leave the query.
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (path) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };
  const items = await get("inventory_items?select=brand&brand=not.is.null&limit=100000");
  const subs = await get("submissions?select=brand&brand=not.is.null&limit=100000");
  const volume = new Map();
  for (const row of [...items, ...subs]) {
    const b = String(row.brand).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!b) continue;
    volume.set(b, (volume.get(b) ?? 0) + 1);
  }
  return volume;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const files = loadMigrations();
  const { kb, st, missing, thin } = styleGaps(files);

  let volume = null;
  if (args.has("--db")) volume = await volumeFromDb();

  const report = {
    brand_knowledge_brands: kb.counts.size,
    brand_styles_rows: [...st.counts.values()].reduce((a, e) => a + e.count, 0),
    brands_with_styles: st.counts.size,
    brands_with_no_style: missing,
    brands_with_one_style: thin,
    unparsed_statements: { brand_knowledge: kb.unparsed, brand_styles: st.unparsed },
    ranked_by_volume: volume
      ? [...volume.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([brand, n]) => ({
          brand,
          items: n,
          styles: st.counts.get(brand)?.count ?? 0,
        }))
        .filter((r) => r.styles === 0)
        .slice(0, 40)
      : null,
  };

  if (args.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`brand_knowledge brands : ${report.brand_knowledge_brands}`);
  console.log(`brand_styles rows      : ${report.brand_styles_rows}`);
  console.log(`brands with >=1 style  : ${report.brands_with_styles}`);
  console.log(`brands with NO style   : ${missing.length}`);
  if (missing.length) console.log(`  ${missing.join(", ")}`);
  console.log(`brands with 1 style    : ${thin.length}`);
  if (thin.length) console.log(`  ${thin.join(", ")}`);
  if (report.unparsed_statements.brand_styles || report.unparsed_statements.brand_knowledge) {
    console.log(
      `\n⚠ unparsed statements: ${JSON.stringify(report.unparsed_statements)} — the counts above are a FLOOR`,
    );
  }
  if (report.ranked_by_volume) {
    console.log(`\nUncovered brands ranked by items we actually see:`);
    for (const r of report.ranked_by_volume) {
      console.log(`  ${String(r.items).padStart(6)}  ${r.brand}`);
    }
  } else {
    console.log(
      `\nNo volume ranking: pass --db with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.`,
    );
    console.log(
      `Seeding order is NOT a substitute for volume — that substitution is what AC1 forbids.`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
