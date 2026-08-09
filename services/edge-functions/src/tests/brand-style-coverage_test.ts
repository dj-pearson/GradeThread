// US-2216: the brand_styles coverage guard.
//
// ⚠ THE STORY'S PREMISE WAS WRONG, and this test is where the correction lives.
// US-2216 says brand_styles "covers a fraction of the KB's brands", citing "70
// migration statements insert into brand_knowledge but only 36 insert into
// brand_styles". Those are FILE counts, not coverage: one migration seeds many
// brands. Counted properly there are 706 style rows across 178 brand keys, and
// 178 of 188 brand_knowledge brands have at least one style. Coverage is ~95%,
// not "a fraction".
//
// So the useful guard is not "seed more" — it is "do not REGRESS". A new brand
// pack that lands a brand_knowledge row and forgets its styles fails here, and
// the allowlist below is the visible, shrinking to-do list. Same pattern as
// rls-guard and cron-registry.
//
//   deno test --allow-read src/tests/brand-style-coverage_test.ts

import { assert, assertEquals } from "@std/assert";

const { loadMigrations, styleGaps, countByBrand } = await import(
  "../../../../scripts/brand-style-coverage.mjs"
);

const files = loadMigrations();
const { kb, st, missing, thin } = styleGaps(files);

/**
 * Brands with a brand_knowledge row and NO brand_styles row.
 *
 * This is a TO-DO LIST, not a permanent exemption. Removing an entry (by
 * seeding real, sourced styles) is the win; ADDING one needs a reason in the
 * commit message, because it means a brand shipped without the model-level
 * identity that sets its price.
 *
 * Several here are genuinely low-style brands where the gap may be correct:
 * Gildan and Hanes are blanks manufacturers whose garments have no model
 * identity worth naming, and a "style" row for them would be noise. Aeropostale,
 * Hollister and Guess are mall brands whose value does not turn on the model.
 * Eddie Bauer, Nautica, Harley-Davidson and Polo Ralph Lauren are the ones worth
 * seeding — each has named, collectible lines.
 */
const KNOWN_UNCOVERED = [
  "aeropostale",
  // US-2220 (00579): three vintage-tee BLANK MAKERS. This is the Gildan/Hanes
  // reason above, in its sharpest form rather than a new exemption — a blank
  // maker HAS no model identity. On a band tee the model is the BAND and the
  // PRINT, which live on the item and cannot be a row in brand_styles.
  //
  // Screen Stars is deliberately NOT in this list: it has documented sub-lines
  // (Screen Stars Best, the 50/50 blank) and both are seeded, which is what the
  // difference between "no styles exist" and "nobody seeded them" looks like.
  "brockum",
  "carharttwip",
  "eddiebauer",
  "giant",
  "gildan",
  "guess",
  "hanes",
  "harleydavidson",
  "hollister",
  "nautica",
  "poloralphlauren",
  "winterland",
] as const;

Deno.test("US-2216: no NEW brand ships without at least one style row", () => {
  const unexpected = missing.filter(
    (b: string) => !(KNOWN_UNCOVERED as readonly string[]).includes(b),
  );
  assertEquals(
    unexpected,
    [],
    "a brand_knowledge brand has no brand_styles row — seed its styles, or add it to KNOWN_UNCOVERED with a reason",
  );
});

Deno.test("US-2216: the allowlist does not outlive the gap it names", () => {
  // The other direction: once a brand is seeded, its entry must be removed, or
  // the list slowly becomes a lie that hides the next real regression.
  const stale = (KNOWN_UNCOVERED as readonly string[]).filter(
    (b) => !missing.includes(b),
  );
  assertEquals(
    stale,
    [],
    "these brands now HAVE styles — delete them from KNOWN_UNCOVERED",
  );
});

Deno.test("US-2216: the parser reads every insert form the packs actually use", () => {
  // The correction that made the numbers trustworthy. Three tuple layouts occur
  // across the packs — one-per-line, tuple-on-the-values-line, and tuple opened
  // with the key on the next line. An earlier parser handled only the first and
  // reported 53 statements unparsed, which under-counted brand_knowledge from
  // 188 to 162 and put brands in the "no styles" list that were not missing.
  assertEquals(kb.unparsed, 0, "brand_knowledge statements went unparsed");
  assertEquals(st.unparsed, 0, "brand_styles statements went unparsed");
  for (const table of ["brand_size_charts", "brand_style_codes", "brand_colorways"]) {
    const r = countByBrand(files, table);
    assertEquals(r.unparsed, 0, `${table} statements went unparsed`);
  }
});

Deno.test("US-2216: coverage is what the corrected count says it is", () => {
  // Pinned so the story's original "a fraction" claim cannot quietly return,
  // and so a large regression is loud rather than a slow drift.
  assert(kb.counts.size >= 180, `brand_knowledge brands fell to ${kb.counts.size}`);
  assert(st.counts.size >= 170, `brands with styles fell to ${st.counts.size}`);
  const rows = [...st.counts.values()].reduce(
    (a: number, e: { count: number }) => a + e.count,
    0,
  );
  assert(rows >= 700, `brand_styles rows fell to ${rows}`);
  // Coverage as a ratio, which is the number the story got wrong.
  const covered = [...kb.counts.keys()].filter((k: string) => st.counts.has(k)).length;
  assert(
    covered / kb.counts.size > 0.9,
    `style coverage is ${covered}/${kb.counts.size}, below the 90% this test records`,
  );
});

Deno.test("US-2216: single-style brands are tracked but not blocked", () => {
  // Depth is a softer signal than absence: one style is thin, not broken. This
  // records the list so it is visible without failing the build over it.
  assert(Array.isArray(thin));
  for (const b of thin) assert(st.counts.has(b));
});
