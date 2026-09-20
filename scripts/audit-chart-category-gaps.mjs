#!/usr/bin/env node
// US-3405: which brand-and-category asks fall through the size-chart narrowing,
// and which of those hand the grading model a chart from the wrong family.
//
// narrowChartsByCategory (services/edge-functions/src/lib/brand-knowledge.ts)
// keeps the charts whose `categoryMatch` the asked-for category contains, and
// falls back to the WHOLE POOL when none matches. The fallback is deliberate --
// a brand whose charts genuinely do not cover the asked category still needs to
// send something -- but it is silent, so a chart list that simply forgot a word
// is indistinguishable from a brand that has no such chart.
//
// Two brands were found by eye when the story was filed: Arc'teryx's tops
// charts do not list `shirt`, and Vuori's bottoms do not list `jean`. This is
// the same question asked of all of them.
//
// WHAT IT COUNTS, and the second number is the one that matters:
//   FALLBACKS      a brand covers a family somewhere in its charts, and no
//                  chart matches a word from that family. The pool is returned.
//   WRONG FAMILY   of those, how many of the THREE charts that actually reach
//                  the model are not in the asked family. Three is
//                  MAX_CHARTS in brand-knowledge.ts, which is where the pool is
//                  sliced. Counting only the head undercounts the harm and
//                  missed the story's own Arc'teryx example, whose head chart is
//                  the right family while two of its three slots are bottoms.
//                  Falling back and still filling all three slots correctly
//                  costs nothing and is not counted.
//
// THREE THINGS IT CANNOT ANSWER, said out loud rather than implied:
//
//  1. The pool order here is the order of the TypeScript seed. In production
//     the order is decided by the database read (US-3399), so the WRONG FAMILY
//     count is the shape of the problem rather than prod's exact number.
//  2. It reads the seed, which generates 00498. A later migration can change a
//     live row without touching the seed -- 00791 did exactly that -- so a
//     finding here is a claim about the code path, not about the table.
//     ⚠ FIXED 2026-09-20 (US-3443): pass `--dsn "postgresql://..."` (or
//     `--container <name>`) and it reads brand_size_charts instead, which is
//     what production answers from. The two differ: 415 charts in the seed
//     against 437 rows in the table after 00813, because several migrations
//     added charts without regenerating sizing-charts.ts -- the hat and cap
//     brands, the menswear-tailoring and boot-width conventions, and seven
//     later sourcing rows. Every seed chart IS in the table; nothing is missing
//     the other way.
//  3. ASKED below is the COMMON category words on purpose. Scoring the whole
//     garment vocabulary produced 305 findings, most of them a chart not
//     listing "monokini", which is a wall nobody can work from.
//
// ⚠ A FOURTH ONE, AND IT IS THE ONE THAT MOVED THE NUMBERS (2026-09-20).
// ASKED is the MEASUREMENT pipeline's vocabulary. The RESOLVER is never called
// with most of it: every caller of resolveBrandKnowledgePack passes a value
// from GARMENT_TYPES, GARMENT_CATEGORIES or ITEM_CATEGORIES (grading-pipeline
// passes submission.garment_category, ai-extract passes categoryHintFromKnown,
// ai-listing passes garment_type ?? garment_category), so "tee", "polo",
// "flannel", "jogger", "chino" and "romper" can never reach it. Scoring them
// counts asks that cannot happen. REACHABLE below is the set that can, and it
// is the one the headline uses. The wide list is kept because it is still the
// right question for the measurement path and because the existing cases pin it.
//
// ⚠ AND THE PIPELINE CHANGED UNDER IT (US-3399, then US-3405). The fallback no
// longer hands back the whole pool: it keeps the brand's charts in the asked
// FAMILY, and only returns everything when the brand has none. So a fallback is
// only harmful now when the brand has nothing in the family, which is the case
// the fallback exists for. WRONG FAMILY is reported both ways below -- as a
// flat slice, which is what shipped when this audit was written, and through
// the family filter, which is what ships now.
//
// Usage:  node scripts/audit-chart-category-gaps.mjs [--all] [--wide]
//                                                     [--dsn "postgresql://..."]
// `--all` prints every brand rather than the worst twenty.
// `--wide` scores the measurement vocabulary instead of the resolver's.
// `--dsn` / `--container` read the TABLE rather than the TypeScript seed.

import ts from "typescript";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { looksUnreachable, psqlTarget } from "./lib/psql-target.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "services/edge-functions/src/lib/sizing-charts.ts";

/**
 * The words the pipeline realistically asks with, by family.
 *
 * Taken from GROUP_WORDS in services/edge-functions/src/lib/
 * measurement-templates.ts and trimmed to the ones a listed garment actually
 * resolves to. Adding a rare word here makes the report longer, not truer.
 */
const ASKED = {
  top: ["shirt", "tee", "top", "sweater", "hoodie", "sweatshirt", "polo", "tank", "blouse", "flannel"],
  bottom: ["pant", "jean", "short", "skirt", "trouser", "legging", "jogger", "chino"],
  outerwear: ["jacket", "coat", "outerwear", "blazer", "vest", "fleece", "cardigan"],
  dress: ["dress", "romper", "jumpsuit"],
};

/**
 * The words the RESOLVER can actually be called with.
 *
 * GARMENT_TYPES + GARMENT_CATEGORIES from
 * services/edge-functions/src/lib/ai-extract.ts, minus the values that map to
 * no chart family (accessories, hat, bag, belt, scarf, neckwear, gloves,
 * other). Every caller of resolveBrandKnowledgePack passes one of these or
 * null, so anything outside it is an ask that cannot happen.
 */
const REACHABLE = {
  top: ["tops", "t-shirt", "shirt", "blouse", "sweater", "hoodie"],
  bottom: ["bottoms", "jeans", "pants", "shorts", "skirt"],
  outerwear: ["outerwear", "jacket", "coat"],
  dress: ["dresses", "dress"],
};

/** Which families a free-text garment scope plainly claims to cover. */
export function claimedFamilies(garment) {
  const g = garment.toLowerCase();
  const out = new Set();
  if (/\btop|shirt|tee|polo|sweater|knit|blouse|jersey/.test(g)) out.add("top");
  if (/bottom|pant|jean|short|skirt|trouser|legging|denim|waist|inseam/.test(g)) out.add("bottom");
  if (/outerwear|jacket|coat|parka|vest|fleece/.test(g)) out.add("outerwear");
  // US-3443: "dress" only counts in the SCOPE head, and never before "shirt".
  // Read across the whole string it filed a dress-shirt chart, a jeans chart
  // whose note says "NOT a dress size" and a footwear chart under `dress`, the
  // same way the shipped garmentFamilies() did until this story fixed it.
  const head = g.split(/[(\u2014]|\s-{1,2}\s/)[0];
  if (/\bdress(es)?\b(?!\s*shirt)/.test(head) || /gown|romper|jumpsuit|swim/.test(g)) {
    out.add("dress");
  }
  return [...out];
}

/** narrowChartsByCategory's own test: the ASKED category contains the token. */
export const categoryMatches = (tokens, word) =>
  tokens.some((m) => word.includes(m.toLowerCase()));

/** Every chart in the seed, by AST rather than by regex. */
export function readCharts(root = ROOT) {
  const file = path.join(root, SRC);
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const charts = [];
  const literal = (p) => p.initializer.getText(source).replace(/^["'`]|["'`]$/g, "");
  const list = (p) =>
    ts.isArrayLiteralExpression(p.initializer)
      ? p.initializer.elements.map((e) => e.getText(source).replace(/^["'`]|["'`]$/g, ""))
      : [];
  (function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (name) =>
        node.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === name);
      const brand = prop("brand");
      const garment = prop("garment");
      const cm = prop("categoryMatch");
      if (brand && garment && cm) {
        const dept = prop("department");
        charts.push({
          brand: literal(brand),
          department: dept ? literal(dept) : "",
          garment: literal(garment),
          categoryMatch: list(cm),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  })(source);
  return charts;
}

/** Every chart in the TABLE, which is what production answers from.
 *
 *  Shaped exactly like readCharts()'s output so every function below is
 *  indifferent to which source it got. The brand is the row's `brand_label`,
 *  which is what the seed's `brand` field holds too. */
export function readChartsFromDb(argv = process.argv.slice(2)) {
  const psql = psqlTarget(argv);
  const sql = `select brand_label || E'\t' || department || E'\t' || garment ` +
    `|| E'\t' || array_to_string(category_match, ',') ` +
    `from public.brand_size_charts order by brand_key, department, garment;`;
  const res = spawnSync(psql.cmd, [...psql.argv, "-c", sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (looksUnreachable(out, res.status)) {
    console.error(`\u2717 could not reach ${psql.how}.\n  ${psql.hint}`);
    process.exit(2);
  }
  const charts = [];
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length !== 4) continue;
    const [brand, department, garment, cats] = parts;
    if (!brand) continue;
    charts.push({
      brand: brand.trim(),
      department: department.trim(),
      garment: garment.trim(),
      categoryMatch: cats.split(",").map((c) => c.trim()).filter(Boolean),
      line: 0,
    });
  }
  // Vacuity floor: an unparsed result reports a corpus with no gaps.
  if (charts.length < 100) {
    console.error(
      `\u2717 only ${charts.length} chart rows parsed from the database - the ` +
        `query or the parse broke, and every finding below would be absent ` +
        `rather than clean.`,
    );
    process.exit(1);
  }
  return charts;
}

/** brand-knowledge.ts slices the pool to this many before the prompt sees it. */
export const MAX_CHARTS = 3;

export { REACHABLE, ASKED };

export function auditFallbacks(charts, vocab = ASKED) {
  const byBrand = new Map();
  for (const c of charts) {
    const key = c.brand.toLowerCase();
    if (!byBrand.has(key)) byBrand.set(key, []);
    byBrand.get(key).push(c);
  }
  const fallbacks = [];
  for (const pool of byBrand.values()) {
    for (const [family, words] of Object.entries(vocab)) {
      // Only ask a brand about a family one of its OWN charts claims. A brand
      // with no tops chart falling back on "shirt" is the fallback doing its job.
      if (!pool.some((c) => claimedFamilies(c.garment).includes(family))) continue;
      for (const word of words) {
        if (pool.some((c) => categoryMatches(c.categoryMatch, word))) continue;
        // What the model read when this audit was written: a flat slice.
        const slots = pool.slice(0, MAX_CHARTS);
        const wrong = slots.filter((c) => !claimedFamilies(c.garment).includes(family));
        // What it reads now: US-3405 keeps only the asked family, and falls
        // back to the whole pool when the brand has nothing in it.
        const inFamily = pool.filter((c) => claimedFamilies(c.garment).includes(family));
        const shipped = (inFamily.length > 0 ? inFamily : pool).slice(0, MAX_CHARTS);
        const wrongNow = shipped.filter((c) => !claimedFamilies(c.garment).includes(family));
        fallbacks.push({
          brand: pool[0].brand,
          word,
          family,
          poolSize: pool.length,
          slots: slots.length,
          wrongSlots: wrong.length,
          wrongSlotsShipped: wrongNow.length,
          wrongGarments: wrong.map((c) => c.garment),
        });
      }
    }
  }
  return { brands: byBrand.size, fallbacks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fromDb = process.argv.includes("--dsn") ||
    process.argv.includes("--container");
  const charts = fromDb ? readChartsFromDb() : readCharts();
  const wide = process.argv.includes("--wide");
  const vocab = wide ? ASKED : REACHABLE;
  const { brands, fallbacks } = auditFallbacks(charts, vocab);
  const wrong = fallbacks.filter((f) => f.wrongSlots > 0);
  const allWrong = fallbacks.filter((f) => f.wrongSlots === f.slots);
  const wrongNow = fallbacks.filter((f) => f.wrongSlotsShipped > 0);

  console.log(
    `[chart-gaps] ${charts.length} charts across ${brands} brands, read from ` +
      `${fromDb ? "the DATABASE" : "the TypeScript seed"}`,
  );
  console.log(
    `[chart-gaps] vocabulary: ${wide ? "MEASUREMENT (wide)" : "RESOLVER (reachable)"} — ` +
      `${Object.values(vocab).flat().length} words`,
  );
  console.log(`[chart-gaps] ${fallbacks.length} brand+category asks fall through the category step`);
  console.log(`[chart-gaps] ${wrong.length} put a WRONG-FAMILY chart in the ${MAX_CHARTS} slots under a FLAT slice (pre-US-3405)`);
  // This is 0 BY CONSTRUCTION and saying so is the point: the audit only asks a
  // brand about a family one of its own charts claims, and the filter keeps
  // exactly those. The number that is not tautological was measured against the
  // table rather than the seed (US-3405): 353 fallbacks where the brand has a
  // right-family chart, 296 wrong-family slots before the filter and 0 after,
  // with 0 pools left returning nothing.
  console.log(`[chart-gaps] ${wrongNow.length} still do under the family filter that ships now (0 by construction — see the comment)`);
  console.log(`[chart-gaps] ${allWrong.length} fill EVERY slot with the wrong family under a flat slice\n`);

  const byBrand = new Map();
  for (const f of wrong) {
    if (!byBrand.has(f.brand)) byBrand.set(f.brand, []);
    byBrand.get(f.brand).push(f);
  }
  const ranked = [...byBrand.entries()].sort((a, b) => b[1].length - a[1].length);
  const shown = process.argv.includes("--all") ? ranked : ranked.slice(0, 20);
  for (const [brand, list] of shown) {
    const worst = list.reduce((a, b) => (b.wrongSlots > a.wrongSlots ? b : a));
    console.log(`${brand} — ${list.length} ask(s) reach the model with a wrong-family chart`);
    console.log(`  asks: ${list.map((f) => `${f.word} (${f.wrongSlots}/${f.slots})`).join(", ")}`);
    console.log(`  worst: "${worst.word}" gets ${worst.wrongGarments.join(" | ")}`);
  }
  if (shown.length < ranked.length) {
    console.log(`\n… ${ranked.length - shown.length} more brands. Pass --all for the full list.`);
  }
}
