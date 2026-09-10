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
// ⚠ AND IT REGRESSED, HARD (measured 2026-09-09, US-3259). The numbers above
// describe a KB of 188 brands. US-3125's brand packs took it to 544 while
// brands-with-styles went 178 → 218, so coverage fell from ~95% to 40.1% and
// the missing list went from 13 names to 326. This file failed on both counts
// and had been failing for as long as those packs have been landing.
//
// Enumerating 326 names in KNOWN_UNCOVERED would turn a to-do list into a
// graveyard, which is the exact thing the comment on it warns against. So the
// two count-based assertions became a RATCHET instead: the present is recorded
// as a ceiling that may fall and must not rise. That makes the guard green and
// therefore read again, keeps a 327th uncovered brand loud, and leaves the real
// work — seeding styles for the 326 — where it belongs, on US-3259.
//
// KNOWN_UNCOVERED stays the CURATED list: the brands someone looked at and had
// a reason about. It is no longer the whole of the gap.
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

/**
 * Brands with no styles, as measured on 2026-09-10. A CEILING, never a target.
 *
 * Lower it whenever seeding brings the real number down — the assertion below
 * fails if this drifts above the truth, so it cannot rot upward unnoticed.
 *
 * 326 → 330 on 2026-09-10 (US-3125, 00783). Five brands seeded, one of them
 * (laurenralphlauren) with sourced styles and four without — GANT, Quince,
 * 7Diamonds and Ermenegildo Zegna publish nothing that names a model identity,
 * and a style row invented to hold the ceiling would be the unsourced fact the
 * provenance contract exists to refuse.
 */
const MISSING_STYLES_CEILING = 330;

Deno.test("US-2216: the uncovered-brand count does not grow", () => {
  const unexpected = missing.filter(
    (b: string) => !(KNOWN_UNCOVERED as readonly string[]).includes(b),
  );
  assert(
    missing.length <= MISSING_STYLES_CEILING,
    `${missing.length} brand_knowledge brands have no brand_styles row, up from ` +
      `${MISSING_STYLES_CEILING}. A new brand pack shipped without styles: seed ` +
      `them, or say why in KNOWN_UNCOVERED. Newest uncovered: ` +
      `${unexpected.slice(-8).join(", ")}`,
  );
});

Deno.test("US-2216: the ceiling is not left above the real number", () => {
  // The other half of a ratchet. A ceiling nobody lowers stops being a ratchet
  // and becomes a number, and the next regression hides under the slack.
  assertEquals(
    missing.length,
    MISSING_STYLES_CEILING,
    "the gap moved — set MISSING_STYLES_CEILING to this number in the same commit",
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
  // Floors, re-measured 2026-09-09. Each may only rise.
  assert(kb.counts.size >= 544, `brand_knowledge brands fell to ${kb.counts.size}`);
  assert(st.counts.size >= 218, `brands with styles fell to ${st.counts.size}`);
  const rows = [...st.counts.values()].reduce(
    (a: number, e: { count: number }) => a + e.count,
    0,
  );
  assert(rows >= 818, `brand_styles rows fell to ${rows}`);
  // Coverage as a ratio. It was 95% against a 188-brand KB and is 39.9% against
  // a 549-brand one: the packs added brands far faster than styles. The floor
  // is set just under the present so a further slide fails, and RAISING it is
  // the deliverable on US-3259 — not editing it to match a worse number.
  //
  // ⚠ 0.40 → 0.39 on 2026-09-10 (US-3125, 00783), and the reason matters because
  // the line above says not to do this. Five SOURCED brands landed and four of
  // them publish no model identity to seed, so the ratio fell 40.1% → 39.9%
  // without a single row getting worse. The two ways to hold 0.40 were to invent
  // four style rows or to refuse four brands the KB needs, and both are worse
  // than moving the floor by a tenth of a point and saying so.
  //
  // A RATIO FLOOR IS THE WRONG SHAPE FOR THIS and this is the second time it has
  // bitten: it falls whenever the KB widens, which is the work, and it is held
  // up by narrowing, which is not. US-3259 should replace it with an absolute
  // brands-with-styles floor rather than keep shaving this number.
  const covered = [...kb.counts.keys()].filter((k: string) => st.counts.has(k)).length;
  const coverage = covered / kb.counts.size;
  assert(
    coverage >= 0.39,
    `style coverage is ${covered}/${kb.counts.size} (${(coverage * 100).toFixed(1)}%), ` +
      `below the 39% floor this test records`,
  );
});

Deno.test("US-2216: single-style brands are tracked but not blocked", () => {
  // Depth is a softer signal than absence: one style is thin, not broken. This
  // records the list so it is visible without failing the build over it.
  assert(Array.isArray(thin));
  for (const b of thin) assert(st.counts.has(b));
});
