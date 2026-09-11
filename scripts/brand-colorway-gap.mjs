#!/usr/bin/env node
// US-3127 -- which brands that sellers HOLD have no colorway palette?
//
// The story this was written for opens with a row count: "brand_colorways has
// been frozen at 159 rows". A row count is the wrong question and this script
// exists to ask the right one. A colorway earns its place by naming something
// the seller cannot name themselves, so the unit that matters is a BRAND WITH A
// PALETTE, weighted by how many items sellers actually hold under that brand.
// 17,813 rows spread over 282 brands and 17,813 rows spread over 30 brands are
// the same number and completely different coverage.
//
// ⚠ THE MEASUREMENT THIS SCRIPT REPLACES WAS ALREADY STALE WHEN IT WAS FILED.
//
// US-3127's "159 rows, 40 brands of 230" was taken from prod on 2026-09-06. The
// colorway harvest (00734, 00737, 00738, 00739, 00756, 00758, 00759, 00761) was
// applied to prod on 2026-09-06 and 2026-09-07 and moved it to 17,813 rows over
// 282 brands. That is exactly why a one-off query becomes a script: a number
// somebody typed once cannot be re-asked, so it gets quoted long after it died.
//
// ── It is the SAME join as brand-kb-gap.mjs, deliberately ──────────────────
//
// Everything in the file header of scripts/brand-kb-gap.mjs applies here and is
// imported rather than restated: brandKey(), the alias-matching rule (a
// key-only join reports brands we already carry as missing), the migration
// scanner that survives dollar-quoted JSON, and the NOT-A-BRAND classification
// from src/lib/brand-field-classification.json. This file adds one thing --
// the colorway side of the join -- and changes the verdict:
//
//   brand-kb-gap.mjs asks   does the KB KNOW this brand?
//   this asks               does the KB know its COLOURS?
//
// So a brand can be COVERED there and NO-PALETTE here, which is the population
// US-3127 is actually about.
//
// ── Two sources, same as the sibling ───────────────────────────────────────
//
//   the KB      the default parses supabase/migrations, which is what a sandbox
//               or CI has, and reports what the migrations PRODUCE.
//               --db reads prod over PostgREST and reports what prod HOLDS.
//   the demand  --brands <file> reads a "count|brand" tally; --db tallies
//               inventory_items.brand.
//
// ⚠ THE DEFAULT MODE CANNOT SEE base_color. 00737 added the column and 00738 /
// 00759 fill it with UPDATEs that re-derive through aspect-normalize.ts, so the
// bucket coverage is not in any INSERT and is not recoverable from the SQL. The
// report says so rather than printing a zero. --db reads it directly.
//
// Neither mode WRITES anything. --db issues SELECTs only.
//
// Run:
//   node scripts/brand-colorway-gap.mjs --self-test
//   node scripts/brand-colorway-gap.mjs --brands scripts/fixtures/brand-kb-gap-prod-2026-09-06.txt
//   node scripts/brand-colorway-gap.mjs            # corpus shape, no demand
//   node scripts/brand-colorway-gap.mjs --db --json

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brandKey,
  splitTuples,
  literal,
  arrayLiteral,
  readKbFromMigrations,
  buildIndex,
  parseBrandList,
} from "./brand-kb-gap.mjs";
import { classifyBrandField } from "./lib/brand-field-classification.mjs";

// fileURLToPath, never url.pathname -- see brand-kb-gap.mjs.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

/**
 * The three filters 00734 measured its ceiling against, kept here so the report
 * can say whether a brand's palette WOULD have passed them.
 *
 * vault/20-domain/brands/brand-colorway-harvest.md owns the reasoning, including
 * why the plain-word rule is conditional: 00756 drops it for a brand that has NO
 * palette at all, because there the comparison is against nothing.
 */
export const MIN_PRODUCTS_PER_COLOUR = 5; // not checkable from SQL; recorded for the reader
export const MIN_COLOURS_PER_BRAND = 8;
export const MAX_PLAIN_WORD_SHARE = 0.35;

/**
 * A "plain colour word" is a name eBay's own Color list already offers, so it
 * tells a listing writer nothing. This is the test 00734's third filter runs.
 *
 * Deliberately a SHORT NAMED LIST and not a heuristic, for the same reason the
 * brand-field classification is: "Sage" and "Rust" and "Camel" are ordinary
 * words and all three are real house colours worth naming.
 */
const PLAIN_COLOUR_WORDS = new Set([
  "black", "white", "grey", "gray", "navy", "blue", "red", "green", "yellow",
  "orange", "purple", "pink", "brown", "beige", "tan", "cream", "ivory",
  "silver", "gold", "multi", "multicolor", "multicolour", "clear", "natural",
]);

export function isPlainColourWord(name) {
  return PLAIN_COLOUR_WORDS.has(String(name ?? "").trim().toLowerCase());
}

// ── Parsing the colorways out of the migrations ────────────────────────────

/**
 * Every brand_colorways row the migrations seed, folded per brand_key.
 *
 * ⚠ Folds on (brand_key, color_name) because every seeding statement in the
 * corpus carries `on conflict (brand_key, color_name) do nothing`. Counting
 * tuples instead of distinct pairs over-reports: 00756 and 00758 deliberately
 * re-offer names an earlier pack already seeded and the database drops them.
 *
 * Reports its unparsed statements. A silent floor here reads exactly like a
 * brand with no palette, which is the finding this script is supposed to make.
 */
export function readColorwaysFromMigrations(dir = MIGRATIONS) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  /** @type {Map<string, {key:string, names:Map<string,{hex:string|null, sourceUrl:string|null, confidence:number|null, from:string}>}>} */
  const brands = new Map();
  let statements = 0;
  const unparsed = [];

  const opener = /insert\s+into\s+public\.([a-z_]+)\s*\(([^)]*)\)\s*values/gi;

  for (const name of files) {
    const sql = readFileSync(join(dir, name), "utf8");
    const opens = [...sql.matchAll(opener)];
    for (let i = 0; i < opens.length; i++) {
      if (opens[i][1].toLowerCase() !== "brand_colorways") continue;
      statements++;
      const cols = opens[i][2].split(",").map((c) => c.trim().toLowerCase());
      const from = opens[i].index + opens[i][0].length;
      const to = i + 1 < opens.length ? opens[i + 1].index : sql.length;
      const tuples = splitTuples(sql.slice(from, to));
      if (tuples.length === 0) {
        unparsed.push(`${name}: brand_colorways insert yielded no tuples`);
        continue;
      }
      const iKey = cols.indexOf("brand_key");
      const iName = cols.indexOf("color_name");
      if (iKey === -1 || iName === -1) {
        unparsed.push(`${name}: brand_colorways insert lacks brand_key/color_name`);
        continue;
      }
      const iHex = cols.indexOf("hex");
      const iSrc = cols.indexOf("source_url");
      const iConf = cols.indexOf("confidence");
      const iAlias = cols.indexOf("aliases");

      for (const t of tuples) {
        const key = literal(t[iKey]);
        const colour = literal(t[iName]);
        if (!key || !colour) continue;
        const row = brands.get(key) ?? { key, names: new Map() };
        // First writer wins: ON CONFLICT DO NOTHING means the earliest pack to
        // offer a (brand, colour) pair is the one whose provenance survives.
        if (!row.names.has(colour)) {
          row.names.set(colour, {
            hex: iHex === -1 ? null : literal(t[iHex]),
            sourceUrl: iSrc === -1 ? null : literal(t[iSrc]),
            confidence: iConf === -1 ? null : parseConfidence(t[iConf]),
            aliases: iAlias === -1 ? [] : arrayLiteral(t[iAlias]),
            from: name,
          });
        }
        brands.set(key, row);
      }
    }
  }

  return { brands, statements, unparsed };
}

function parseConfidence(raw) {
  const n = Number(String(raw ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Fold a parsed brand into the numbers the report ranks on. */
export function summarise(entry) {
  const names = [...entry.names.keys()];
  const rows = [...entry.names.values()];
  const plain = names.filter(isPlainColourWord).length;
  return {
    key: entry.key,
    colours: names.length,
    plain,
    plainShare: names.length ? plain / names.length : 0,
    withHex: rows.filter((r) => r.hex).length,
    unsourced: rows.filter((r) => !r.sourceUrl || r.confidence === null).length,
    thin: names.length < MIN_COLOURS_PER_BRAND,
    packs: [...new Set(rows.map((r) => r.from))].sort(),
  };
}

// ── The join ───────────────────────────────────────────────────────────────

/**
 * Score seller demand against KB coverage AND palette coverage.
 *
 * Four verdicts, and the middle two are the ones US-3127 is about:
 *
 *   NO-KB-ROW    the brand is not in brand_knowledge at all  -> brand-kb-gap.mjs
 *   NO-PALETTE   KB row, zero colorways                      -> a pack to write
 *   THIN         KB row, 1..7 colorways                      -> below 00734's bar
 *   COVERED      KB row, 8+ colorways
 *   NOT-A-BRAND  brand-field noise; never a pack
 */
export function scoreColorwayGap(demand, index, colorways) {
  const noKbRow = [];
  const noPalette = [];
  const thin = [];
  const covered = [];
  const notBrand = [];

  for (const d of demand) {
    const k = brandKey(d.brand);
    if (!k) continue;
    const hit = index.get(k);
    if (!hit) {
      const verdict = classifyBrandField(d.brand);
      if (verdict.class !== "maker") {
        notBrand.push({ ...d, class: verdict.class, reason: verdict.reason });
      } else {
        noKbRow.push({ ...d, key: k });
      }
      continue;
    }
    const entry = colorways.get(hit.key);
    const row = { ...d, key: hit.key, via: hit.via };
    if (!entry) { noPalette.push({ ...row, colours: 0 }); continue; }
    const s = summarise(entry);
    if (s.thin) thin.push({ ...row, ...s });
    else covered.push({ ...row, ...s });
  }

  const bycount = (a, b) => (b.count - a.count) || a.brand.localeCompare(b.brand);
  for (const list of [noKbRow, noPalette, thin, covered, notBrand]) list.sort(bycount);
  return { noKbRow, noPalette, thin, covered, notBrand };
}

// ── Corpus shape, for when there is no demand tally to hand ────────────────

export function corpusShape(kbRows, colorways) {
  let rows = 0;
  let withHex = 0;
  let unsourced = 0;
  let thinBrands = 0;
  const orphans = [];
  const kbKeys = new Set(kbRows.map((r) => r.key));

  for (const [key, entry] of colorways) {
    const s = summarise(entry);
    rows += s.colours;
    withHex += s.withHex;
    unsourced += s.unsourced;
    if (s.thin) thinBrands++;
    if (!kbKeys.has(key)) orphans.push(key);
  }

  return {
    kbBrands: kbRows.length,
    brandsWithPalette: colorways.size,
    brandsWithNoPalette: kbRows.filter((r) => !colorways.has(r.key)).length,
    colorwayRows: rows,
    withHex,
    unsourced,
    thinBrands,
    orphans: orphans.sort(),
  };
}

// ── Inputs ─────────────────────────────────────────────────────────────────

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

async function pageAll(env, table, select, pageSize = 1000) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const batch = await pgrest(env, `${table}?select=${select}&limit=${pageSize}&offset=${offset}`);
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

  check("plain colour word", isPlainColourWord("Navy") && isPlainColourWord(" black "));
  check("a house colour is not plain", !isPlainColourWord("Spiced Chai") && !isPlainColourWord("Sage"));

  const kb = [
    { key: "vuori", canonical: "Vuori", aliases: ["vuori clothing"] },
    { key: "prana", canonical: "prAna", aliases: ["prana living"] },
    { key: "lululemon", canonical: "lululemon", aliases: ["lululemon athletica"] },
  ];
  const index = buildIndex(kb);

  const colorways = new Map([
    ["lululemon", { key: "lululemon", names: new Map([
      ["Black", { hex: "#000000", sourceUrl: "https://shop.lululemon.com/x", confidence: 0.55, from: "t" }],
      ["True Navy", { hex: null, sourceUrl: "https://shop.lululemon.com/x", confidence: 0.55, from: "t" }],
      ["Spiced Chai", { hex: null, sourceUrl: "https://shop.lululemon.com/x", confidence: 0.55, from: "t" }],
      ["Heathered Core", { hex: null, sourceUrl: "https://shop.lululemon.com/x", confidence: 0.55, from: "t" }],
      ["Dark Olive", { hex: null, sourceUrl: "https://shop.lululemon.com/x", confidence: 0.55, from: "t" }],
      ["Bone", { hex: null, sourceUrl: "https://shop.lululemon.com/x", confidence: 0.55, from: "t" }],
      ["Java", { hex: null, sourceUrl: "https://shop.lululemon.com/x", confidence: 0.55, from: "t" }],
      ["Trench", { hex: null, sourceUrl: null, confidence: null, from: "t" }],
    ]) }],
    ["prana", { key: "prana", names: new Map([
      ["Sandbar", { hex: null, sourceUrl: "https://www.prana.com/p.json", confidence: 0.75, from: "t" }],
    ]) }],
  ]);

  const demand = [
    { brand: "lululemon athletica", count: 20 },  // covered, alias-only
    { brand: "prAna Living", count: 8 },          // THIN, alias-only
    { brand: "Vuori", count: 12 },                // KB row, NO palette
    { brand: "Gant", count: 8 },                  // no KB row at all
    { brand: "Cashmere", count: 3 },              // not a brand
  ];
  const r = scoreColorwayGap(demand, index, colorways);

  check("a brand with a KB row and no colours is NO-PALETTE",
    r.noPalette.length === 1 && r.noPalette[0].key === "vuori", JSON.stringify(r.noPalette));
  check("a brand with fewer than 8 colours is THIN",
    r.thin.length === 1 && r.thin[0].key === "prana" && r.thin[0].colours === 1, JSON.stringify(r.thin));
  check("8 or more colours is COVERED",
    r.covered.length === 1 && r.covered[0].colours === 8, JSON.stringify(r.covered));
  check("a brand with no KB row is NOT reported as a colorway gap",
    r.noKbRow.length === 1 && r.noKbRow[0].brand === "Gant", JSON.stringify(r.noKbRow));
  check("brand-field noise is classified, never proposed",
    r.notBrand.length === 1 && r.notBrand[0].brand === "Cashmere", JSON.stringify(r.notBrand));

  // THE CASE brand-kb-gap.mjs's AC2 exists for, re-pinned on THIS join: a
  // key-only match would call prAna Living a missing brand and propose a pack
  // for a palette we already hold under `prana`.
  check("the palette join matches through aliases too",
    r.thin[0]?.via === "alias", JSON.stringify(r.thin[0]));

  // ON CONFLICT folding: the same pair offered twice is one colorway, and the
  // FIRST offer's provenance is the one that survives.
  const dup = readColorwayTuplesForTest(
    `insert into public.brand_colorways (brand_key, color_name, hex, source_url, confidence, verified, updated_by) values\n` +
    `  ('x', 'Oat', NULL, 'https://a', 0.75, false, 'migration:1'),\n` +
    `  ('x', 'Oat', NULL, 'https://b', 0.55, false, 'migration:2')\n` +
    `on conflict (brand_key, color_name) do nothing;`,
  );
  check("a duplicate (brand, colour) folds to one row", dup.get("x")?.names.size === 1,
    JSON.stringify([...(dup.get("x")?.names.keys() ?? [])]));
  check("the FIRST offer's provenance survives the fold",
    dup.get("x")?.names.get("Oat")?.sourceUrl === "https://a",
    dup.get("x")?.names.get("Oat")?.sourceUrl);

  // The real corpus must parse. A silent floor reads exactly like a gap.
  const real = readColorwaysFromMigrations();
  const kbReal = readKbFromMigrations();
  const shape = corpusShape(kbReal.rows, real.brands);
  check("migrations yield a real colorway corpus", shape.colorwayRows >= 10000,
    `${shape.colorwayRows} rows`);
  check("no unparsed brand_colorways statements", real.unparsed.length === 0,
    real.unparsed.slice(0, 3).join(" | "));
  check("every colorway brand_key has a brand_knowledge row", shape.orphans.length === 0,
    shape.orphans.slice(0, 5).join(", "));

  if (failures.length) {
    console.error("SELF-TEST FAILED");
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(
    `self-test OK -- ${shape.colorwayRows} colorways over ${shape.brandsWithPalette} brands ` +
    `from ${real.statements} statements, 0 unparsed, 0 orphan keys`,
  );
}

/** Test helper: parse one literal statement without touching the filesystem. */
function readColorwayTuplesForTest(sql) {
  const brands = new Map();
  const opener = /insert\s+into\s+public\.([a-z_]+)\s*\(([^)]*)\)\s*values/gi;
  const opens = [...sql.matchAll(opener)];
  for (const open of opens) {
    const cols = open[2].split(",").map((c) => c.trim().toLowerCase());
    const tuples = splitTuples(sql.slice(open.index + open[0].length));
    const iKey = cols.indexOf("brand_key");
    const iName = cols.indexOf("color_name");
    const iSrc = cols.indexOf("source_url");
    for (const t of tuples) {
      const key = literal(t[iKey]);
      const colour = literal(t[iName]);
      if (!key || !colour) continue;
      const row = brands.get(key) ?? { key, names: new Map() };
      if (!row.names.has(colour)) {
        row.names.set(colour, { sourceUrl: iSrc === -1 ? null : literal(t[iSrc]) });
      }
      brands.set(key, row);
    }
  }
  return brands;
}

// ── Report ─────────────────────────────────────────────────────────────────

function reportCorpus(shape, meta) {
  console.log(`brand colorway corpus -- ${meta.kbSource}`);
  console.log(`  brands in brand_knowledge        ${shape.kbBrands}`);
  console.log(`  brands WITH a palette            ${shape.brandsWithPalette}  (${pct(shape.brandsWithPalette, shape.kbBrands)})`);
  console.log(`  brands with NO palette           ${shape.brandsWithNoPalette}  (${pct(shape.brandsWithNoPalette, shape.kbBrands)})`);
  console.log(`  brands with a THIN palette (<${MIN_COLOURS_PER_BRAND})   ${shape.thinBrands}`);
  console.log(`  distinct colorway rows           ${shape.colorwayRows}`);
  console.log(`  rows carrying a hex              ${shape.withHex}`);
  console.log(`  rows missing source_url/conf     ${shape.unsourced}`);
  if (meta.bucketsKnown === false) {
    console.log(`\n  base_color coverage: NOT MEASURABLE in this mode. 00737 added the`);
    console.log(`  column and 00738/00759 fill it with UPDATEs that re-derive through`);
    console.log(`  aspect-normalize.ts, so no INSERT carries it. Use --db.`);
  }
}

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}

function reportGap(result, meta, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ ...meta, ...result }, null, 2));
    return;
  }
  console.log(
    `colorway gap -- KB from ${meta.kbSource} (${meta.kbRows} brands, ${meta.paletteBrands} with a palette), ` +
    `demand from ${meta.demandSource} (${meta.demandRows} distinct brands, ${meta.demandItems} items)`,
  );
  if (meta.unparsed?.length) {
    console.log(`\n⚠ ${meta.unparsed.length} unparsed statement(s):`);
    for (const u of meta.unparsed) console.log(`   ${u}`);
  }

  console.log(`\nNO PALETTE -- held by sellers, KB row exists, ZERO colorways (${result.noPalette.length}):`);
  if (!result.noPalette.length) console.log("   (none)");
  for (const m of result.noPalette) {
    console.log(`   ${String(m.count).padStart(5)}  ${m.brand}   -> ${m.key} (${m.via})`);
  }

  console.log(`\nTHIN -- fewer than ${MIN_COLOURS_PER_BRAND} colorways, below 00734's own bar (${result.thin.length}):`);
  if (!result.thin.length) console.log("   (none)");
  for (const t of result.thin) {
    console.log(`   ${String(t.count).padStart(5)}  ${t.brand}   ${t.colours} colour(s), ${t.plain} plain  [${t.packs.join(", ")}]`);
  }

  console.log(`\nCOVERED -- ${MIN_COLOURS_PER_BRAND}+ colorways (${result.covered.length}):`);
  for (const c of result.covered) {
    console.log(`   ${String(c.count).padStart(5)}  ${c.brand}   ${c.colours} colour(s), ${pct(c.plain, c.colours)} plain`);
  }
  if (!result.covered.length) console.log("   (none)");

  console.log(`\nNO KB ROW AT ALL -- a brand-kb-gap.mjs problem, not a colorway one (${result.noKbRow.length}):`);
  for (const n of result.noKbRow) console.log(`   ${String(n.count).padStart(5)}  ${n.brand}`);
  if (!result.noKbRow.length) console.log("   (none)");

  console.log(`\nNOT A BRAND -- never a pack (${result.notBrand.length}):`);
  for (const n of result.notBrand) console.log(`   ${String(n.count).padStart(5)}  ${n.brand}   [${n.class}] ${n.reason}`);
  if (!result.notBrand.length) console.log("   (none)");
}

// ── Entry ──────────────────────────────────────────────────────────────────

async function main(argv) {
  if (argv.includes("--self-test")) return selfTest();

  const asJson = argv.includes("--json");
  const useDb = argv.includes("--db");
  const bi = argv.indexOf("--brands");
  const brandsFile = bi === -1 ? null : argv[bi + 1];

  const env = readEnv();
  let kb, colorways, kbSource, unparsed = [], bucketsKnown = false, buckets = null;

  if (useDb) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || /^</.test(env.SUPABASE_SERVICE_ROLE_KEY)) {
      console.error("--db needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. The repo .env carries a placeholder, not a key.");
      process.exit(2);
    }
    const rows = await pageAll(env, "brand_knowledge", "brand_key,canonical_brand,aliases");
    kb = rows.map((r) => ({ key: r.brand_key, canonical: r.canonical_brand, aliases: r.aliases ?? [] }));
    const cw = await pageAll(env, "brand_colorways", "brand_key,color_name,hex,source_url,confidence,base_color");
    colorways = new Map();
    let withBucket = 0;
    for (const r of cw) {
      const entry = colorways.get(r.brand_key) ?? { key: r.brand_key, names: new Map() };
      if (!entry.names.has(r.color_name)) {
        entry.names.set(r.color_name, {
          hex: r.hex, sourceUrl: r.source_url, confidence: r.confidence, aliases: [], from: "prod",
        });
      }
      colorways.set(r.brand_key, entry);
      if (r.base_color) withBucket++;
    }
    buckets = { rows: cw.length, withBucket, nullBucket: cw.length - withBucket };
    bucketsKnown = true;
    kbSource = "prod brand_knowledge + brand_colorways";
  } else {
    const parsedKb = readKbFromMigrations();
    const parsedCw = readColorwaysFromMigrations();
    kb = parsedKb.rows;
    colorways = parsedCw.brands;
    unparsed = [...parsedKb.unparsed, ...parsedCw.unparsed];
    kbSource = `supabase/migrations (${parsedKb.statements} brand + ${parsedCw.statements} colorway statements)`;
  }

  let demand = null, demandSource = null;
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
  }

  if (!demand) {
    const shape = corpusShape(kb, colorways);
    if (asJson) { console.log(JSON.stringify({ kbSource, bucketsKnown, buckets, ...shape }, null, 2)); return; }
    reportCorpus(shape, { kbSource, bucketsKnown });
    if (buckets) {
      console.log(`  rows with a base_color           ${buckets.withBucket}`);
      console.log(`  rows with a NULL base_color      ${buckets.nullBucket}`);
    }
    return;
  }

  const index = buildIndex(kb);
  const result = scoreColorwayGap(demand, index, colorways);
  reportGap(result, {
    kbSource,
    kbRows: kb.length,
    paletteBrands: colorways.size,
    demandSource,
    demandRows: demand.length,
    demandItems: demand.reduce((a, d) => a + d.count, 0),
    unparsed,
    buckets,
  }, asJson);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("brand-colorway-gap.mjs")
) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
