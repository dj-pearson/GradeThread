// US-2922: a VERIFIED chart in the database must not be contradicted by the
// in-code fallback.
//
// THE HAZARD, and it is specific to the size checker. resolveBrandKnowledgePack
// reads brand_size_charts first and falls back to SIZING_CHARTS. The fallback is
// silent by construction, so a brand whose DB read fails — a transient error, a
// container that booted before a migration applied — quietly gets the in-code
// numbers instead. That was harmless while the charts only fed a prompt. It is
// not harmless now: the composer's tolerance turns on the tier, and a `verified`
// chart is one a human checked against the brand's own published guide. If the
// code seed for the same brand and department says something different, the
// seller sees one answer today and a different one tomorrow, both stated with
// the same confidence.
//
// So: every chart a migration marks verified must either have a code-seed
// counterpart (same brand key, department and garment) or be listed here as
// deliberately DB-only. Nothing is allowed to be verified in the DB and merely
// absent from the code by accident.
//
// This reads the MIGRATIONS rather than a live database on purpose. It is the
// migrations that decide what prod holds, they are in the repo, and a guard
// that needs credentials is a guard that does not run in CI.
//
//   deno test --allow-env --allow-read src/tests/verified-chart-parity_test.ts

import { assert, assertEquals } from "@std/assert";

const { SIZING_CHARTS } = await import("../lib/sizing-charts.ts");
const { brandKey } = await import("../lib/brand-normalize.ts");

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);

/**
 * Charts that are deliberately in the DB and NOT in sizing-charts.ts.
 *
 * An entry is a decision that a chart belongs in the operator-curated table and
 * has no business being compiled into the edge image — add it with the reason,
 * not to silence a failure.
 *
 * The seven below are all HEADWEAR or SHOE WIDTH, and they are DB-only for the
 * same reason: sizing-charts.ts is the GARMENT corpus that grounds the vision
 * prompt, and the size checker builds bands only for chest, bust, waist, hip and
 * inseam. A head circumference and a boot width have no ease and no band, so
 * compiling them into the edge would add rows nothing reads. They were seeded
 * verified against the makers' own published charts (00574, 00582, 00583) and
 * that is where they should stay.
 */
const DB_ONLY: Record<string, string> = {
  "newera|unisex|caps (fitted 59fifty, eighth-inch sizes)":
    "headwear: head circumference, no garment band",
  "newera|unisex|caps (stretch-fit 39thirty / adjustable 9fifty)":
    "headwear: head circumference, no garment band",
  "stetson|unisex|hats (us hat sizes)":
    "headwear: head circumference, no garment band",
  "kangol|unisex|hats (alpha s–xxl)":
    "headwear: head circumference, no garment band",
  "goorinbros|unisex|hats (alpha xs–xxl)":
    "headwear: head circumference, no garment band",
  "golfshoewidth|men|golf shoe widths (letter axis)":
    "shoe width: a letter axis, not a measurement the checker bands",
  "westernbootwidth|men|boot widths (letter axis)":
    "shoe width: a letter axis, not a measurement the checker bands",
};

interface SeededChart {
  migration: string;
  brandKey: string;
  department: string;
  garment: string;
  verified: boolean;
  sourceUrl: string | null;
}

/** Unquote a Postgres single-quoted literal, collapsing the doubled quotes. */
function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/''/g, "'");
}

/**
 * Split one VALUES row into its top-level values.
 *
 * Hand-rolled because the values include `ARRAY['a','b']`, `$json$…$json$` and
 * single-quoted prose containing commas — none of which a split(",") survives.
 */
function splitValues(row: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let inDollar = false;
  let current = "";
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (inDollar) {
      current += ch;
      if (row.startsWith("$json$", i)) {
        current += row.slice(i + 1, i + 6);
        i += 5;
        inDollar = false;
      }
      continue;
    }
    if (inQuote) {
      current += ch;
      if (ch === "'") {
        if (row[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inQuote = false;
        }
      }
      continue;
    }
    if (row.startsWith("$json$", i)) {
      current += "$json$";
      i += 5;
      inDollar = true;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Every brand_size_charts row every migration seeds. */
async function readSeededCharts(): Promise<SeededChart[]> {
  const out: SeededChart[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(entry.name, MIGRATIONS_DIR));
    const inserts = sql.matchAll(
      /insert\s+into\s+public\.brand_size_charts\s*\(([^)]*)\)\s*values\s*([\s\S]*?)\n\s*on\s+conflict/gi,
    );
    for (const insert of inserts) {
      const columns = insert[1]!.split(",").map((c) => c.trim().toLowerCase());
      const body = insert[2]!;
      // Rows are `( … )` at the top level of the VALUES list.
      const rows = splitValues(body);
      for (const row of rows) {
        const trimmed = row.trim();
        if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) continue;
        const values = splitValues(trimmed.slice(1, -1));
        if (values.length !== columns.length) continue;
        const at = (name: string): string | undefined => {
          const i = columns.indexOf(name);
          return i === -1 ? undefined : values[i];
        };
        const key = at("brand_key");
        const department = at("department");
        const garment = at("garment");
        if (!key || !department || !garment) continue;
        const sourceUrl = at("source_url");
        out.push({
          migration: entry.name,
          brandKey: unquote(key),
          department: unquote(department),
          garment: unquote(garment),
          verified: (at("verified") ?? "false").trim().toLowerCase() === "true",
          sourceUrl:
            sourceUrl && sourceUrl.trim().toLowerCase() !== "null"
              ? unquote(sourceUrl.trim())
              : null,
        });
      }
    }
  }
  return out;
}

const seeded = await readSeededCharts();

const codeCharts = new Set(
  SIZING_CHARTS.map((c) =>
    `${brandKey(c.brand)}|${c.department}|${c.garment}`.toLowerCase()
  ),
);

Deno.test("the parser found the corpus (guards the guard)", () => {
  // Every count below reads as a pass when the parse silently returns nothing.
  assert(
    seeded.length > 100,
    `only parsed ${seeded.length} seeded charts — the VALUES parser has broken, ` +
      `and every assertion below is now vacuous`,
  );
  assert(codeCharts.size > 100, `only ${codeCharts.size} in-code charts`);
});

Deno.test("every VERIFIED seeded chart has a code counterpart or is declared DB-only", () => {
  const orphans = seeded
    .filter((c) => c.verified)
    .filter((c) => {
      const id = `${c.brandKey}|${c.department}|${c.garment}`.toLowerCase();
      return !codeCharts.has(id) && !DB_ONLY[id];
    })
    .map((c) => `${c.brandKey} / ${c.department} / ${c.garment} (${c.migration})`);

  assertEquals(
    orphans,
    [],
    "These charts are marked verified in the database but have no counterpart in " +
      "sizing-charts.ts, so a fallback read serves numbers a human never checked:\n  " +
      orphans.join("\n  ") +
      "\n\nAdd the chart to sizing-charts.ts (and re-run " +
      "scripts/gen-sizing-chart-seed.mjs), or list it in DB_ONLY with the reason.",
  );
});

Deno.test("a DB_ONLY entry still describes a chart that exists", () => {
  const seededIds = new Set(
    seeded.map((c) => `${c.brandKey}|${c.department}|${c.garment}`.toLowerCase()),
  );
  const stale = Object.keys(DB_ONLY).filter((id) => !seededIds.has(id));
  assertEquals(
    stale,
    [],
    `DB_ONLY entries that no longer match any seeded chart — remove them: ${stale.join(", ")}`,
  );
});

Deno.test("a verified chart carries the brand's own source URL", () => {
  // US-2922 AC3: verified is only allowed after a human compared the rows
  // against a published guide, so a verified row with no URL is a row nobody
  // could have checked.
  const unsourced = seeded
    .filter((c) => c.verified && !c.sourceUrl)
    .map((c) => `${c.brandKey} / ${c.department} (${c.migration})`);
  assertEquals(
    unsourced,
    [],
    `verified with no source_url:\n  ${unsourced.join("\n  ")}`,
  );
});
