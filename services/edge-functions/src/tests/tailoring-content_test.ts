// US-2220 AC3: verify the tailoring / formalwear content (migration 00581).
//
// AC3 is the criterion this pack exists for — "chest+length letter suffixes
// (40R/40L/40S) and DROP are the sizing system, not an alpha size; this cannot
// reuse the tops chart shape unchanged". It cannot, because:
//
//     A SUIT SIZE IS TWO GARMENTS AND A SUBTRACTION.
//
// "40R" is a 40-inch jacket chest in Regular length and says NOTHING about the
// trouser waist. That comes from the DROP — chest minus waist — which is a
// property of the maker's cut, so the same printed 40R is a 32, 34 or 36 waist
// depending on who made it. Three charts are seeded because there are three real
// systems (chest run, length letters, dress-shirt neck x sleeve).
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);

const SQL = await Deno.readTextFile(
  new URL(
    "../../../../supabase/migrations/00581_tailoring_formalwear_brand_knowledge.sql",
    import.meta.url,
  ),
);

/** See the note in scrubs-uniform-content_test.ts — phrase assertions read this. */
const PROSE = SQL.replace(/^\s*--\s?/gm, " ").replace(/\s+/g, " ");

Deno.test("US-2220: the tailoring aliases canonicalize", () => {
  for (const brand of ["Suitsupply", "Hugo Boss", "Canali", "Jos. A. Bank"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  // brandKey strips the periods and spaces, and sellers type the plural.
  for (const spelling of ["Jos. A. Bank", "jos a bank", "JosABanks", "Joseph A Bank"]) {
    assertEquals(canonicalizeBrand(spelling), "Jos. A. Bank", `${spelling} resolves`);
  }
  assertEquals(canonicalizeBrand("boss"), "Hugo Boss");
});

Deno.test("US-2220: 'Boss' resolves by TAG but is never minted from prose", () => {
  // The documented asymmetry: an ordinary-word KEY is safe because the alias map
  // is an exact whole-field lookup; an ordinary-word VALUE scanned over prose is
  // not. The canonical here is the full "Hugo Boss", which nobody writes by
  // accident — so no exclusion is needed, and this test pins that reasoning so
  // shortening the canonical cannot pass silently.
  assertEquals(canonicalizeBrand("BOSS"), "Hugo Boss", "reachable by tag");
  assertEquals(
    detectBrandInText("Nike tee, boss print on the front, size L"),
    "Nike",
    "an ordinary 'boss' in prose must not mint the house",
  );
  assertEquals(
    detectBrandInText("Hugo Boss two-button suit, 40R"),
    "Hugo Boss",
    "the full name in prose does mean the house",
  );
});

Deno.test("US-2220 AC3: the three sizing systems are seeded as three charts", () => {
  const charts = [...SQL.matchAll(/'tailoringmenswear', 'Menswear tailoring \(US convention\)'/g)];
  assertEquals(charts.length, 3, "chest run, length letters, dress shirts");
  for (const garment of [
    "Suits & sport coats (jacket chest, with 6-drop trouser waist)",
    "Jacket length letters (S / R / L)",
    "Dress shirts (neck x sleeve)",
  ]) {
    assert(SQL.includes(garment), `the ${garment} chart is seeded`);
  }
});

Deno.test("US-2220 AC3: the chart is the chest, and the waist is arithmetic", () => {
  // The number on the label is the JACKET CHEST. The trouser waist shown is the
  // 6-drop default and is NOT part of the label — that is the whole point.
  assert(
    SQL.includes('{"size":"40R","measurements":{"chest":"40","trouser_waist_at_6_drop":"34"}}'),
    "a 40R is a 40 chest, and 34 is chest minus the 6-drop default",
  );
  // Every seeded row must hold that arithmetic, or the chart is lying.
  const rows = [...SQL.matchAll(/\{"size":"(\d+)R","measurements":\{"chest":"(\d+)","trouser_waist_at_6_drop":"(\d+)"\}\}/g)];
  assert(rows.length >= 7, `expected the chest run, saw ${rows.length} rows`);
  for (const [, label, chest, waist] of rows) {
    assertEquals(label, chest, "the label number IS the chest");
    assertEquals(
      Number(chest) - Number(waist),
      6,
      `${label}R must show a 6-drop waist, saw ${waist}`,
    );
  }
});

Deno.test("US-2220 AC3: drop is recorded as the maker's cut, not the label", () => {
  // If this is lost, the chart reads as "a 40R has a 34 waist", which is exactly
  // the false precision the AC is warning about.
  assert(
    PROSE.includes("A SUIT SIZE IS TWO GARMENTS AND A SUBTRACTION"),
    "the system is named, not just tabulated",
  );
  for (const drop of ["4-drop", "6-drop", "8-drop"]) {
    assert(PROSE.includes(drop), `the pack names ${drop}`);
  }
  assert(
    PROSE.includes("has not given the trouser size"),
    "and says what a label-only listing has failed to state",
  );
});

Deno.test("US-2220 AC3: the length letter moves length, never chest", () => {
  // A 40S, 40R and 40L all fit a 40-inch chest. A chart that let the letter
  // change the chest would be a different garment.
  assert(
    SQL.includes('{"size":"S (short)","measurements":{"jacket_length_vs_regular":"-1.5"}}'),
    "S is a negative length delta",
  );
  assert(
    SQL.includes('{"size":"L (long)","measurements":{"jacket_length_vs_regular":"1.5"}}'),
    "L is a positive one",
  );
  const letters = SQL.slice(SQL.indexOf("Jacket length letters"));
  assert(
    !/"chest"/.test(letters.slice(0, letters.indexOf("]$json$"))),
    "the letter chart must not carry a chest — the letter never changes it",
  );
});

Deno.test("US-2220: a dress shirt keeps its half-inch neck increments", () => {
  // Neck x sleeve is a third system. Converting it to alpha loses the half-inch
  // steps that are the entire reason it exists.
  assert(SQL.includes('"neck":"15.5"'), "half-inch necks are seeded");
  assert(SQL.includes('"sleeve":"34-35"'), "and sleeve is a two-inch range");
  assert(
    PROSE.includes("Converting either number into an alpha size loses"),
    "and the note says what a conversion would destroy",
  );
});

Deno.test("US-2220: an incomplete suit is priced as a sport coat", () => {
  // The fact that matters most in resale, and it is not a size.
  assert(
    PROSE.includes("A JACKET WITHOUT ITS TROUSERS IS A SPORT COAT"),
    "completeness is stated as a pricing question",
  );
});

Deno.test("US-2220: the label is treated as unreliable, and inlay as value", () => {
  // Tailored clothing is altered and the tag never changes, so this category
  // depends on measurement more than any other the KB covers — and unused
  // let-out room is worth money, which is the same fact from the other side.
  assert(
    PROSE.includes("THE LABEL IS OFTEN A LIE"),
    "the alteration problem is stated plainly",
  );
  assert(PROSE.includes("inlay"), "and the value of unused let-out room is recorded");
});

Deno.test("US-2220 AC2: volume is justified, and volume is not value", () => {
  // AC2 asks for the resale-volume justification in the header. The Jos. A. Bank
  // entry is the one that earns its place: high volume, low value, and the same
  // promotional history explains both.
  assert(
    PROSE.includes("BRAND SELECTION JUSTIFIED BY RESALE VOLUME"),
    "the AC2 justification is in the header",
  );
  assert(
    PROSE.includes("HIGH VOLUME IS NOT HIGH VALUE"),
    "and the KB does not let unit volume read as desirability",
  );
});

Deno.test("US-2220: no decoder — the label carries a SIZE", () => {
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "a size identifies no maker, which makes it the worst possible decoder",
  );
});
