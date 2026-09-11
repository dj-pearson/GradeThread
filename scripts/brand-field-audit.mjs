#!/usr/bin/env node
// US-3307 AC1 -- how much of inventory_items.brand is not a brand?
//
// THE STORY TITLE SAYS "roughly 8 percent" AND THAT NUMBER IS AN EXTRAPOLATION.
// It is 2 out of the top 25 DISTINCT values by item count. Two things are wrong
// with quoting it as the answer:
//
//   1. It is the head of a long-tail distribution. The head is where the real
//      brands are (a brand gets into the top 25 by being held a lot), so the
//      noise rate in the head is the LOWEST rate in the table, not the average.
//      Whatever the true figure is, 8% read off the top 25 is a floor.
//   2. It counts DISTINCT VALUES, not ITEMS. "8% of the brand field" sounds like
//      items. Eight items out of the ~1,300 the top 25 covers is a different
//      claim entirely, and it is the one a seller feels.
//
// So this script reports BOTH denominators, every time, and prints the
// population it actually reached. It never estimates.
//
// ── What it can reach ──────────────────────────────────────────────────────
//
//   --db          tallies inventory_items.brand over PostgREST. Needs a real
//                 SUPABASE_SERVICE_ROLE_KEY. The repo .env carries a
//                 PLACEHOLDER, so this mode cannot run on the dev box.
//   --brands <f>  scores a tally somebody already captured ("count|brand" or a
//                 bare brand per line). The only prod measurement checked into
//                 this repo is scripts/fixtures/brand-kb-gap-prod-2026-09-06.txt,
//                 which is 18 values out of the top 25 -- a snapshot of a
//                 fragment of the head. Say so when quoting it.
//
// Neither mode WRITES anything. --db issues SELECTs only.
//
// Run:
//   node scripts/brand-field-audit.mjs --self-test
//   node scripts/brand-field-audit.mjs --brands scripts/fixtures/brand-kb-gap-prod-2026-09-06.txt
//   node scripts/brand-field-audit.mjs --db
//   node scripts/brand-field-audit.mjs --db --json

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRAND_FIELD_CLASSES,
  BRAND_FIELD_CLASSIFICATION_VERSION,
  CLASS_ORDER,
  PARITY_CASES,
  classifyBrandField,
  tallyBrandField,
} from "./lib/brand-field-classification.mjs";
import { parseBrandList } from "./brand-kb-gap.mjs";

// fileURLToPath, never url.pathname -- see the note in brand-kb-gap.mjs.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    const batch = await pgrest(
      env,
      `${table}?select=${select}&limit=${pageSize}&offset=${offset}`,
    );
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

// ── Report ─────────────────────────────────────────────────────────────────

function pct(n, d) {
  if (!d) return "n/a";
  return `${((n / d) * 100).toFixed(1)}%`;
}

export function buildReport(demand) {
  const tally = tallyBrandField(demand);
  const detail = demand
    .map((d) => ({ ...d, verdict: classifyBrandField(d.brand) }))
    .sort((a, b) => (b.count - a.count) || a.verdict.value.localeCompare(b.verdict.value));
  return { tally, detail };
}

function report({ tally, detail }, meta, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ ...meta, ...tally, detail }, null, 2));
    return;
  }

  console.log(
    `brand-field audit -- classification v${BRAND_FIELD_CLASSIFICATION_VERSION}`,
  );
  console.log(`population: ${meta.population}`);
  console.log(
    `denominators: ${tally.totalValues} distinct brand values, ${tally.totalItems} items`,
  );
  console.log("");

  const w = (s, n) => String(s).padStart(n);
  console.log(
    "  class        distinct   of values        items    of items",
  );
  for (const row of tally.rows) {
    if (row.values === 0 && row.items === 0) continue;
    console.log(
      `  ${String(row.class).padEnd(11)}${w(row.values, 8)}${w(pct(row.values, tally.totalValues), 12)}` +
        `${w(row.items, 13)}${w(pct(row.items, tally.totalItems), 12)}`,
    );
  }

  console.log("");
  console.log(
    `NO RECORDED MAKER: ${tally.valuesWithNoMaker}/${tally.totalValues} distinct values ` +
      `(${pct(tally.valuesWithNoMaker, tally.totalValues)}), ` +
      `${tally.itemsWithNoMaker}/${tally.totalItems} items ` +
      `(${pct(tally.itemsWithNoMaker, tally.totalItems)})`,
  );
  console.log(
    "  'unbranded' is EXCLUDED from that: eBay ships Unbranded and Handmade as real",
  );
  console.log(
    "  Brand aspect values, so a seller who typed one answered the question (AC4).",
  );

  const flagged = detail.filter((d) => !d.verdict.recordsMaker);
  console.log("");
  console.log(`Values with no maker recorded (${flagged.length}):`);
  if (!flagged.length) console.log("   (none)");
  for (const f of flagged) {
    console.log(
      `  ${String(f.count).padStart(5)}  ${(f.verdict.value || "(empty)").padEnd(24)} ${f.verdict.class}`,
    );
    console.log(`         ${f.verdict.reason}`);
  }

  const unbranded = detail.filter((d) => d.verdict.class === "unbranded");
  console.log("");
  console.log(
    `Recorded as having no label (${unbranded.length} value(s), ${unbranded.reduce((s, u) => s + u.count, 0)} items) -- a real answer, not a gap:`,
  );
  if (!unbranded.length) console.log("   (none)");
  for (const u of unbranded) {
    console.log(`  ${String(u.count).padStart(5)}  ${u.verdict.value}`);
  }

  console.log("");
  console.log(
    "⚠ Unrecognised values count as 'maker' by design, so this is a FLOOR on the",
  );
  console.log(
    "  noise, never a ceiling. The list is named, never heuristic: see the header",
  );
  console.log("  of src/lib/brand-field-classification.json for why.");
}

// ── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const failures = [];
  const check = (name, cond, detail) => {
    if (!cond) failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
  };

  for (const [value, expected] of PARITY_CASES) {
    const got = classifyBrandField(value).class;
    check(`classify ${JSON.stringify(value)} -> ${expected}`, got === expected, got);
  }

  // AC4, stated as a test rather than as a comment: Unbranded records a maker
  // answer and Unknown does not, and neither is the same as an empty field.
  check("Unbranded records a maker answer", classifyBrandField("Unbranded").recordsMaker);
  check("Unknown does not", classifyBrandField("Unknown").recordsMaker === false);
  check("blank is its own class", classifyBrandField(null).class === "blank");
  check(
    "Unknown and blank are distinguishable",
    classifyBrandField("Unknown").class !== classifyBrandField("").class,
  );

  // Every declared class must have metadata, or the report prints undefined.
  for (const c of CLASS_ORDER) {
    check(`class ${c} has metadata`, !!BRAND_FIELD_CLASSES[c]);
  }

  // The tally must count both ways and must not double-count.
  const t = tallyBrandField([
    { brand: "Nike", count: 10 },
    { brand: "Norman Rockwell", count: 5 },
    { brand: "Cashmere", count: 3 },
    { brand: "Unbranded", count: 2 },
    { brand: "", count: 4 },
  ]);
  check("tally totals items", t.totalItems === 24, String(t.totalItems));
  check("tally totals values", t.totalValues === 5, String(t.totalValues));
  check(
    "unbranded is NOT counted as missing a maker",
    t.itemsWithNoMaker === 12,
    String(t.itemsWithNoMaker),
  );
  check(
    "rows sum back to the totals",
    t.rows.reduce((s, r) => s + r.items, 0) === t.totalItems,
  );

  // The captured prod fixture must still parse and score, or the one measurement
  // this repo holds becomes unreadable without anyone noticing.
  const fixture = join(ROOT, "scripts", "fixtures", "brand-kb-gap-prod-2026-09-06.txt");
  const demand = parseBrandList(readFileSync(fixture, "utf8"));
  check("fixture parses", demand.length === 18, `${demand.length} values`);
  const ft = tallyBrandField(demand);
  check(
    "fixture still finds the licensor and the fibre",
    ft.valuesWithNoMaker === 2,
    `${ft.valuesWithNoMaker} flagged`,
  );

  if (failures.length) {
    console.error("SELF-TEST FAILED");
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(
    `self-test OK -- ${PARITY_CASES.length} classification cases, fixture scores ` +
      `${ft.valuesWithNoMaker}/${ft.totalValues} values and ${ft.itemsWithNoMaker}/${ft.totalItems} items with no maker`,
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
  let demand, population;

  if (brandsFile) {
    demand = parseBrandList(readFileSync(brandsFile, "utf8"));
    population = `${brandsFile} (a captured tally, NOT the live table)`;
  } else if (useDb) {
    if (
      !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY ||
      /^</.test(env.SUPABASE_SERVICE_ROLE_KEY)
    ) {
      console.error(
        "--db needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. The repo .env carries a placeholder, not a key.",
      );
      process.exit(2);
    }
    // Every row, including the ones with a NULL brand: a null IS the answer to
    // "how many items have no recorded maker", and selecting only non-null
    // brands would drop the largest class from the denominator.
    const items = await pageAll(env, "inventory_items", "brand");
    const tally = new Map();
    for (const it of items) {
      const b = (it.brand ?? "").trim();
      tally.set(b, (tally.get(b) ?? 0) + 1);
    }
    demand = [...tally].map(([brand, count]) => ({ brand, count }));
    population = `prod inventory_items, EVERY row (${items.length} items, ${demand.length} distinct values incl. blank)`;
  } else {
    console.error(
      "Nothing to score. Pass --brands <file> (a 'count|brand' tally) or --db.",
    );
    process.exit(2);
  }

  report(buildReport(demand), { population }, asJson);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("brand-field-audit.mjs")
) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
