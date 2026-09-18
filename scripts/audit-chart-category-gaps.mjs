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
//  3. ASKED below is the COMMON category words on purpose. Scoring the whole
//     garment vocabulary produced 305 findings, most of them a chart not
//     listing "monokini", which is a wall nobody can work from.
//
// Usage:  node scripts/audit-chart-category-gaps.mjs [--all]
// `--all` prints every brand rather than the worst twenty.

import ts from "typescript";
import { readFileSync } from "node:fs";
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

/** Which families a free-text garment scope plainly claims to cover. */
export function claimedFamilies(garment) {
  const g = garment.toLowerCase();
  const out = new Set();
  if (/\btop|shirt|tee|polo|sweater|knit|blouse|jersey/.test(g)) out.add("top");
  if (/bottom|pant|jean|short|skirt|trouser|legging|denim|waist|inseam/.test(g)) out.add("bottom");
  if (/outerwear|jacket|coat|parka|vest|fleece/.test(g)) out.add("outerwear");
  if (/dress|gown|romper|jumpsuit|swim/.test(g)) out.add("dress");
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

/** brand-knowledge.ts slices the pool to this many before the prompt sees it. */
export const MAX_CHARTS = 3;

export function auditFallbacks(charts) {
  const byBrand = new Map();
  for (const c of charts) {
    const key = c.brand.toLowerCase();
    if (!byBrand.has(key)) byBrand.set(key, []);
    byBrand.get(key).push(c);
  }
  const fallbacks = [];
  for (const pool of byBrand.values()) {
    for (const [family, words] of Object.entries(ASKED)) {
      // Only ask a brand about a family one of its OWN charts claims. A brand
      // with no tops chart falling back on "shirt" is the fallback doing its job.
      if (!pool.some((c) => claimedFamilies(c.garment).includes(family))) continue;
      for (const word of words) {
        if (pool.some((c) => categoryMatches(c.categoryMatch, word))) continue;
        // What the model actually reads: the first MAX_CHARTS of the pool.
        const slots = pool.slice(0, MAX_CHARTS);
        const wrong = slots.filter((c) => !claimedFamilies(c.garment).includes(family));
        fallbacks.push({
          brand: pool[0].brand,
          word,
          family,
          poolSize: pool.length,
          slots: slots.length,
          wrongSlots: wrong.length,
          wrongGarments: wrong.map((c) => c.garment),
        });
      }
    }
  }
  return { brands: byBrand.size, fallbacks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const charts = readCharts();
  const { brands, fallbacks } = auditFallbacks(charts);
  const wrong = fallbacks.filter((f) => f.wrongSlots > 0);
  const allWrong = fallbacks.filter((f) => f.wrongSlots === f.slots);

  console.log(`[chart-gaps] ${charts.length} charts across ${brands} brands`);
  console.log(`[chart-gaps] ${fallbacks.length} brand+category asks fall back to the whole pool`);
  console.log(`[chart-gaps] ${wrong.length} of those put a WRONG-FAMILY chart in the ${MAX_CHARTS} slots the model reads`);
  console.log(`[chart-gaps] ${allWrong.length} fill EVERY slot with the wrong family\n`);

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
