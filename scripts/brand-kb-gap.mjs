#!/usr/bin/env node
// US-3125 AC2 -- which brands do our sellers hold that the brand KB does not know?
//
// This is the join that found the eight brands US-3125 was filed for, written
// down so the question can be RE-ASKED instead of re-derived. It was a one-off
// query typed against prod on 2026-09-06; two days later nobody could say which
// rows it had actually compared, which is the whole reason a measurement becomes
// a script.
//
// ⚠ IT MUST MATCH ON canonical_brand AND aliases, NOT ONLY ON brand_key.
//
// This is the single mistake that makes the report worthless, and it fails in
// the expensive direction: a key-only join reports brands we ALREADY CARRY as
// missing, and the next person seeds a duplicate under a second key. Worked
// example, and it is in the live data:
//
//   seller types  "prAna Living"      ->  key "pranaliving"
//   the KB row is  brand_key "prana"  ->  aliases include "prana living"
//
// Key-only: no match, reported missing, someone seeds `pranaliving`. Matching
// the aliases array as well: covered. `--self-test` pins exactly this case.
//
// ⚠ AND IT MUST CLASSIFY THE ROWS THAT ARE NOT BRANDS AT ALL.
//
// The brand field is free text and sellers type what is on the garment. Two of
// the top twenty-five values measured on 2026-09-06 were not brands: "norman
// rockwell" (a licensor -- the artist, printed on the front) and "cashmere" (a
// fibre). A report that lists those as MISSING invites a pack for each, and both
// packs would assert that a licensor or a material is a garment maker. They are
// evidence about the FIELD. See vault/20-domain/brands/brand-kb-negative-findings.md.
//
// US-3307 moved that classification OUT of this file and into
// src/lib/brand-field-classification.json, which is now the only copy. To ask
// how big the field problem is rather than which packs to write, run
// scripts/brand-field-audit.mjs.
//
// ── Two sources for each side, because the useful data lives in prod ────────
//
//   the KB     --db reads brand_knowledge over PostgREST; the default parses
//              supabase/migrations, which is what a sandbox or CI has.
//   the demand --db tallies inventory_items.brand; --brands <file> reads a
//              tally somebody already has ("count|brand" or a bare brand per
//              line), so a prod query result can be re-scored offline.
//
// Neither mode WRITES anything. --db issues SELECTs only.
//
// Run:
//   node scripts/brand-kb-gap.mjs --self-test
//   node scripts/brand-kb-gap.mjs --brands seller-brands.txt
//   node scripts/brand-kb-gap.mjs --db
//   node scripts/brand-kb-gap.mjs --db --json

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRAND_FIELD_VALUES,
  classifyBrandField,
} from "./lib/brand-field-classification.mjs";

// fileURLToPath, never url.pathname: on Windows the pathname of a file: URL is
// "/C:/Users/..." and readdirSync rejects the leading slash, so a guard that
// imports this script fails locally while passing in CI.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

/**
 * The match key, and it is deliberately a COPY of brandKey() in
 * services/edge-functions/src/lib/brand-normalize.ts rather than an import:
 * that file is Deno TypeScript and this is a Node script. Keep them identical.
 *
 * Lowercase, then drop everything that is not [a-z0-9]. That strips accents to
 * nothing, which is not a bug and is the reason the KB spells Stussy `stssy` and
 * Aime Leon Dore `aimleondore` -- seeding the accented spelling mints a second
 * key for the same house.
 */
export function brandKey(raw) {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Brand-field values that are NOT brands, with the reason each was refused.
 *
 * ⚠ US-3307: THIS IS NO LONGER A LIST. It is a view onto the single shared
 * classification in src/lib/brand-field-classification.json, read through
 * scripts/lib/brand-field-classification.mjs.
 *
 * It used to be twelve values hardcoded here, which was the SECOND copy of this
 * knowledge: src/lib/placeholder-brand.ts held eighteen and a third check lived
 * inline in services/edge-functions/src/lib/style-code-prospect.ts. They had
 * already drifted. Only this one knew Norman Rockwell was a licensor, and only
 * placeholder-brand.ts got the Unbranded distinction right. A gap report is the
 * surface where a stale copy is most expensive, because its output is a list of
 * packs somebody is about to write.
 *
 * The shared file keeps the rule that made the list worth having: a short, NAMED
 * set with a recorded reason on each, never a heuristic. A classifier that
 * guessed "this looks like a material" would eventually swallow MOTHER, FRAME,
 * Quince or Vince, all ordinary words and all real houses, and a silently
 * swallowed brand is invisible. An unrecognised value is still always MISSING.
 *
 * Kept as a Map of key -> reason so callers that predate US-3307 see no change.
 */
export const NOT_A_BRAND = new Map(
  BRAND_FIELD_VALUES.map((v) => [v.key, `${v.class}: ${v.reason}`]),
);

// ── Parsing the KB out of the migrations ───────────────────────────────────

/**
 * Split a `values (...), (...)` body into top-level tuples, then into fields.
 *
 * Written as a scanner rather than a regex because the packs embed dollar-quoted
 * JSON (`$j$[{"tell": ...}]$j$`) whose prose contains commas, parentheses,
 * semicolons and apostrophes. A regex that stops at `;` truncates the statement
 * BEFORE its tuples and silently reports zero rows -- the exact failure that
 * made a first pass at scripts/brand-style-coverage.mjs under-count by 53
 * statements and produce a wrong "brands with no styles" list.
 */
export function splitTuples(body) {
  const tuples = [];
  let i = 0;
  let depth = 0;
  // ARRAY['a','b'] puts an unquoted comma at tuple depth. Brackets are counted
  // separately so that comma does NOT split a field -- the first pass here did
  // exactly that and turned every aliases column into two fields, shifting every
  // column after it by one.
  let brackets = 0;
  let field = "";
  let fields = null;

  while (i < body.length) {
    const ch = body[i];

    // Dollar-quoted string: copy verbatim to its matching close tag.
    if (ch === "$") {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(body.slice(i));
      if (tag) {
        const close = body.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? body.length : close + tag[0].length;
        const chunk = body.slice(i, end);
        if (fields) field += chunk;
        i = end;
        continue;
      }
    }

    // Single-quoted string, with '' as the embedded quote.
    if (ch === "'") {
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === "'") {
          if (body[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      const chunk = body.slice(i, j);
      if (fields) field += chunk;
      i = j;
      continue;
    }

    // Line comment inside the VALUES body -- the packs annotate rows.
    if (ch === "-" && body[i + 1] === "-") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl;
      continue;
    }

    if (ch === "(") {
      depth++;
      if (depth === 1) { fields = []; field = ""; i++; continue; }
      field += ch; i++; continue;
    }

    if (ch === ")") {
      depth--;
      if (depth === 0 && fields) {
        fields.push(field);
        tuples.push(fields);
        fields = null;
        field = "";
        i++;
        continue;
      }
      field += ch; i++; continue;
    }

    if (ch === "[") { brackets++; if (fields) field += ch; i++; continue; }
    if (ch === "]") { brackets--; if (fields) field += ch; i++; continue; }

    if (ch === "," && depth === 1 && brackets === 0 && fields) {
      fields.push(field);
      field = "";
      i++;
      continue;
    }

    // Outside any tuple, `on conflict` / `;` ends the statement.
    if (depth === 0) {
      if (ch === ";") break;
      if (/^on\s+conflict/i.test(body.slice(i))) break;
    }

    if (fields) field += ch;
    i++;
  }

  return tuples;
}

/** Unquote a SQL literal field; returns null for NULL / a non-literal. */
export function literal(raw) {
  const s = String(raw ?? "").trim();
  const m = /^'((?:[^']|'')*)'/.exec(s);
  if (!m) return null;
  return m[1].replace(/''/g, "'");
}

/** Parse `ARRAY['a','b']::text[]` (or `'{}'`) into a list of strings. */
export function arrayLiteral(raw) {
  const s = String(raw ?? "").trim();
  if (/^array\s*\[\s*\]/i.test(s)) return [];
  const inner = /^array\s*\[([\s\S]*?)\]/i.exec(s);
  if (!inner) return [];
  const out = [];
  for (const m of inner[1].matchAll(/'((?:[^']|'')*)'/g)) {
    out.push(m[1].replace(/''/g, "'"));
  }
  return out;
}

/**
 * Every brand_knowledge row the migrations seed, as {key, canonical, aliases}.
 *
 * Reports its unparsed statements. A silent floor here reads exactly like a
 * small KB, and a small KB makes every seller brand look missing.
 */
export function readKbFromMigrations(dir = MIGRATIONS) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const rows = new Map();
  let statements = 0;
  const unparsed = [];

  const opener = /insert\s+into\s+public\.([a-z_]+)\s*\(([^)]*)\)\s*values/gi;

  for (const name of files) {
    const sql = readFileSync(join(dir, name), "utf8");
    const opens = [...sql.matchAll(opener)];
    for (let i = 0; i < opens.length; i++) {
      if (opens[i][1].toLowerCase() !== "brand_knowledge") continue;
      statements++;
      const cols = opens[i][2].split(",").map((c) => c.trim().toLowerCase());
      const from = opens[i].index + opens[i][0].length;
      const to = i + 1 < opens.length ? opens[i + 1].index : sql.length;
      const tuples = splitTuples(sql.slice(from, to));
      if (tuples.length === 0) {
        unparsed.push(`${name}: brand_knowledge insert yielded no tuples`);
        continue;
      }
      const iKey = cols.indexOf("brand_key");
      const iCanon = cols.indexOf("canonical_brand");
      const iAlias = cols.indexOf("aliases");
      if (iKey === -1) {
        unparsed.push(`${name}: brand_knowledge insert has no brand_key column`);
        continue;
      }
      for (const t of tuples) {
        const key = literal(t[iKey]);
        if (!key) continue;
        const prev = rows.get(key) ?? { key, canonical: null, aliases: [] };
        const canon = iCanon === -1 ? null : literal(t[iCanon]);
        const aliases = iAlias === -1 ? [] : arrayLiteral(t[iAlias]);
        rows.set(key, {
          key,
          canonical: canon ?? prev.canonical,
          aliases: [...new Set([...prev.aliases, ...aliases])],
        });
      }
    }
  }

  return { rows: [...rows.values()], statements, unparsed };
}

// ── The join itself ────────────────────────────────────────────────────────

/**
 * Index every string that resolves to a KB row, remembering WHICH column it came
 * from so the report can show what a key-only join would have got wrong.
 */
export function buildIndex(rows) {
  const index = new Map();
  const add = (s, key, via) => {
    const k = brandKey(s);
    if (!k) return;
    if (!index.has(k)) index.set(k, { key, via });
  };
  for (const r of rows) {
    add(r.key, r.key, "brand_key");
    if (r.canonical) add(r.canonical, r.key, "canonical_brand");
    for (const a of r.aliases) add(a, r.key, "alias");
  }
  return index;
}

/**
 * Score seller brand tallies against the index.
 *
 * `demand` is [{ brand, count }]. Returns covered / missing / notBrand, plus
 * `aliasOnly` -- the rows a KEY-ONLY join would have wrongly called missing,
 * which is the number that says whether AC2's rule earned its place.
 */
export function scoreGap(demand, index) {
  const covered = [];
  const missing = [];
  const notBrand = [];
  const aliasOnly = [];

  for (const d of demand) {
    const k = brandKey(d.brand);
    if (!k) continue;
    const hit = index.get(k);
    if (hit) {
      const row = { ...d, key: hit.key, via: hit.via };
      covered.push(row);
      if (hit.via !== "brand_key") aliasOnly.push(row);
      continue;
    }
    // US-3307: one shared classification, not a second list. `maker` is the
    // default for anything unnamed, so an unrecognised value still lands in
    // MISSING and a human sees it.
    const verdict = classifyBrandField(d.brand);
    if (verdict.class !== "maker") {
      notBrand.push({ ...d, class: verdict.class, reason: verdict.reason });
      continue;
    }
    missing.push({ ...d, key: k });
  }

  const bycount = (a, b) => (b.count - a.count) || a.brand.localeCompare(b.brand);
  covered.sort(bycount); missing.sort(bycount);
  notBrand.sort(bycount); aliasOnly.sort(bycount);
  return { covered, missing, notBrand, aliasOnly };
}

// ── Inputs ─────────────────────────────────────────────────────────────────

/** "12|Gant" / "12 Gant" / "Gant" per line; blank lines and # comments skipped. */
export function parseBrandList(text) {
  const tally = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\d+)\s*[|\t]\s*(.+)$/.exec(line) ?? /^(\d+)\s+(.+)$/.exec(line);
    const brand = (m ? m[2] : line).trim();
    const count = m ? Number(m[1]) : 1;
    tally.set(brand, (tally.get(brand) ?? 0) + count);
  }
  return [...tally].map(([brand, count]) => ({ brand, count }));
}

function readEnv() {
  const out = { ...process.env };
  const file = join(ROOT, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && !out[m[1]]) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

async function pgrest(env, path) {
  const url = `${String(env.SUPABASE_URL).replace(/\/$/, "")}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return res.json();
}

/** Page through a table; PostgREST caps a response and we want every row. */
async function pageAll(env, table, select, pageSize = 1000) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const batch = await pgrest(
      env,
      `${table}?select=${select}&limit=${pageSize}&offset=${offset}`,
    );
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

// ── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const failures = [];
  const check = (name, cond, detail) => {
    if (!cond) failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
  };

  // The u-umlaut is DELIBERATE and load-bearing: it is the character the key
  // must strip. See vault/20-domain/brands/brand-kb-alias-refusals.md.
  check("brandKey strips accents to nothing", brandKey("Stüssy") === "stssy", brandKey("Stüssy"));
  check("brandKey strips punctuation", brandKey("Mizzen+Main") === "mizzenmain");
  check("brandKey handles digits", brandKey("7 Diamonds") === "7diamonds");

  const kb = [
    { key: "prana", canonical: "prAna", aliases: ["prana", "pranaliving", "prana living"] },
    { key: "ralphlauren", canonical: "Ralph Lauren", aliases: ["ralphlauren", "poloralphlauren"] },
  ];
  const index = buildIndex(kb);

  // THE CASE AC2 EXISTS FOR: covered only because the aliases array was joined.
  const alias = scoreGap([{ brand: "prAna Living", count: 8 }], index);
  check("alias join covers 'prAna Living'", alias.missing.length === 0 && alias.covered[0]?.via === "alias",
    JSON.stringify(alias.missing));
  const keyOnly = buildIndex(kb.map((r) => ({ ...r, canonical: null, aliases: [] })));
  check("a key-only join would report it MISSING",
    scoreGap([{ brand: "prAna Living", count: 8 }], keyOnly).missing.length === 1);

  // A sub-label must NOT be swallowed by its house: the index is exact-match,
  // never substring, so "Lauren Ralph Lauren" stays missing until it is seeded.
  const sub = scoreGap([{ brand: "Lauren Ralph Lauren", count: 6 }], index);
  check("a sub-label does not match its house", sub.missing.length === 1, JSON.stringify(sub));

  // Non-brands are classified, not proposed as packs.
  const noise = scoreGap(
    [{ brand: "Norman Rockwell", count: 5 }, { brand: "Cashmere", count: 3 }],
    index,
  );
  check("non-brand values are classified", noise.notBrand.length === 2 && noise.missing.length === 0,
    JSON.stringify(noise.missing));

  // The scanner must survive dollar-quoted JSON containing commas and parens.
  const tuples = splitTuples(
    `('a','A',ARRAY['a','a2']::text[], $j$[{"tell":"x, (y)","detail":"; z"}]$j$, 'src'),\n` +
    `('b','B',ARRAY[]::text[], '[]'::jsonb, 'src') on conflict (brand_key) do nothing;`,
  );
  check("scanner reads both tuples past dollar-quoted JSON", tuples.length === 2, `got ${tuples.length}`);
  check("scanner keeps 5 fields per tuple", tuples.every((t) => t.length === 5),
    JSON.stringify(tuples.map((t) => t.length)));
  check("array literal parses", arrayLiteral(tuples[0][2]).join(",") === "a,a2");

  // The real corpus must parse, or every seller brand looks missing.
  const real = readKbFromMigrations();
  check("migrations yield a real KB", real.rows.length >= 400, `${real.rows.length} rows`);
  check("no unparsed brand_knowledge statements", real.unparsed.length === 0,
    real.unparsed.slice(0, 3).join(" | "));

  if (failures.length) {
    console.error("SELF-TEST FAILED");
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`self-test OK -- ${real.rows.length} KB rows from ${real.statements} statements, 0 unparsed`);
}

// ── Report ─────────────────────────────────────────────────────────────────

function report(result, meta, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ ...meta, ...result }, null, 2));
    return;
  }
  console.log(`brand KB gap -- KB from ${meta.kbSource} (${meta.kbRows} rows), demand from ${meta.demandSource} (${meta.demandRows} distinct brands)`);
  if (meta.unparsed?.length) {
    console.log(`\n⚠ ${meta.unparsed.length} unparsed statement(s):`);
    for (const u of meta.unparsed) console.log(`   ${u}`);
  }

  console.log(`\nMISSING -- held by sellers, absent from the KB (${result.missing.length}):`);
  if (!result.missing.length) console.log("   (none)");
  for (const m of result.missing) console.log(`   ${String(m.count).padStart(5)}  ${m.brand}   [key would be ${m.key}]`);

  console.log(`\nNOT A BRAND -- brand-field noise, do NOT seed (${result.notBrand.length}):`);
  if (!result.notBrand.length) console.log("   (none)");
  for (const n of result.notBrand) {
    console.log(`   ${String(n.count).padStart(5)}  ${n.brand}   [${n.class}] ${n.reason}`);
  }

  console.log(`\nCOVERED (${result.covered.length}), of which ${result.aliasOnly.length} only via canonical_brand/aliases:`);
  for (const a of result.aliasOnly) console.log(`   ${String(a.count).padStart(5)}  ${a.brand}  ->  ${a.key} (${a.via})`);
  if (!result.aliasOnly.length) console.log("   (every covered brand matched on brand_key too)");
  console.log(
    `\n⚠ A KEY-ONLY JOIN WOULD HAVE REPORTED ${result.aliasOnly.length} BRAND(S) WE ALREADY CARRY AS MISSING.`,
  );
}

// ── Entry ──────────────────────────────────────────────────────────────────

async function main(argv) {
  if (argv.includes("--self-test")) return selfTest();

  const asJson = argv.includes("--json");
  const useDb = argv.includes("--db");
  const bi = argv.indexOf("--brands");
  const brandsFile = bi === -1 ? null : argv[bi + 1];

  const env = readEnv();
  let kb, kbSource, unparsed = [];
  if (useDb) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || /^</.test(env.SUPABASE_SERVICE_ROLE_KEY)) {
      console.error("--db needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. The repo .env carries a placeholder, not a key.");
      process.exit(2);
    }
    const rows = await pageAll(env, "brand_knowledge", "brand_key,canonical_brand,aliases");
    kb = rows.map((r) => ({ key: r.brand_key, canonical: r.canonical_brand, aliases: r.aliases ?? [] }));
    kbSource = "prod brand_knowledge";
  } else {
    const parsed = readKbFromMigrations();
    kb = parsed.rows;
    unparsed = parsed.unparsed;
    kbSource = `supabase/migrations (${parsed.statements} statements)`;
  }

  let demand, demandSource;
  if (brandsFile) {
    demand = parseBrandList(readFileSync(brandsFile, "utf8"));
    demandSource = brandsFile;
  } else if (useDb) {
    const items = await pageAll(env, "inventory_items", "brand");
    const tally = new Map();
    for (const it of items) {
      const b = (it.brand ?? "").trim();
      if (b) tally.set(b, (tally.get(b) ?? 0) + 1);
    }
    demand = [...tally].map(([brand, count]) => ({ brand, count }));
    demandSource = "prod inventory_items.brand";
  } else {
    console.error("Nothing to score. Pass --brands <file> (a 'count|brand' tally) or --db.");
    process.exit(2);
  }

  const index = buildIndex(kb);
  report(scoreGap(demand, index), {
    kbSource, kbRows: kb.length, demandSource, demandRows: demand.length, unparsed,
  }, asJson);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("brand-kb-gap.mjs")) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
