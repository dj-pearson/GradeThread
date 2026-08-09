// US-2220: verify the swim content (migration 00585). The seventh and last
// category on the story.
//
// The category's defining fact, and the sharpest instance of a shape this epic
// kept finding:
//
//     CHLORINE CONSUMES THE GARMENT, AND IT DOES IT INVISIBLY.
//
// Chlorine attacks the elastane first, so the suit loses recovery and then sags
// and goes translucent — with no stain, no tear and no fade to grade. A
// competition suit can be functionally spent while photographing perfectly.
//
// ⚠ AND THE BEST PREDICTOR IS ON THE CARE LABEL, which is unusual enough to be
// the pack's headline: fibre content ranks the expected life, and it is printed.
// PBT/polyester lasts longest, nylon-elastane breaks down fastest. In this one
// category, read the composition before the photographs.
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
    "../../../../supabase/migrations/00585_swim_brand_knowledge.sql",
    import.meta.url,
  ),
);

/** See scrubs-uniform-content_test.ts — phrase assertions read this, not SQL. */
const PROSE = SQL
  .replace(/^\s*--\s?/gm, " ")
  .replace(/''/g, "'")
  .replace(/\s+/g, " ");

Deno.test("US-2220: the swim aliases canonicalize", () => {
  for (const brand of ["Speedo", "TYR", "Vilebrequin", "Andie"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  assertEquals(canonicalizeBrand("tyr sport"), "TYR");
  assertEquals(canonicalizeBrand("andie swim"), "Andie");
});

Deno.test("US-2220: 'TYR' resolves by TAG but is never minted from prose", () => {
  // Three letters and a Norse god. Short all-caps tokens turn up in listing copy
  // as sizes, codes and initials.
  assertEquals(canonicalizeBrand("TYR"), "TYR", "reachable by tag");
  assertEquals(
    detectBrandInText("Nike shorts, TYR code on the label, size M"),
    "Nike",
    "a short all-caps token in prose must not mint the swim house",
  );
});

Deno.test("US-2220: no print or pattern name is mapped as a brand", () => {
  // Vilebrequin sells on seasonal prints and the print is a STYLE. Putting one
  // in the brand field is the same error as putting a golf course there.
  for (const print of ["Moorea", "Turtles", "Micro Ronde"]) {
    assert(
      canonicalizeBrand(print) !== "Vilebrequin",
      `${print} is a print, not the maker`,
    );
  }
  assert(
    PROSE.includes("THE PRINT IS THE MODEL, AND IT IS NOT THE BRAND"),
    "and the rule is stated on the brand row",
  );
});

Deno.test("US-2220: the invisible failure is stated, with the composition rule", () => {
  assert(
    PROSE.includes("CHLORINE CONSUMES THE GARMENT, AND IT DOES IT INVISIBLY"),
    "the category's defining fact is named",
  );
  assert(
    PROSE.includes("READ THE COMPOSITION BEFORE THE PHOTOS"),
    "and the actionable inversion is carried in a tell",
  );
  // The ranking is the actionable part — it has to name all three tiers, or a
  // grader cannot use it.
  for (const fibre of ["PBT", "polyester", "nylon"]) {
    assert(PROSE.includes(fibre), `the pack names the ${fibre} tier`);
  }
});

Deno.test("US-2220: loss of recovery IS the defect here", () => {
  // Removing a signal without replacing it leaves the grader blind. The pack has
  // to say what to look for when there is no stain or tear to find.
  assert(
    PROSE.includes("Sagging and translucency are the failure"),
    "the real defect is named",
  );
  assert(
    PROSE.includes("no longer springs back") || PROSE.includes("see-through when stretched"),
    "and it says how to test for it",
  );
});

Deno.test("US-2220: the hygiene liner is listability, not condition", () => {
  assert(
    PROSE.includes("THE HYGIENE LINER IS A LISTING-ELIGIBILITY FACT"),
    "the framing is stated",
  );
  // ⚠ And the pack must FLAG rather than adjudicate — policies differ and
  // change, the same discipline the CITES tell uses in 00582.
  assert(
    PROSE.includes("DOES NOT STATE ANY PARTICULAR MARKETPLACE'S RULE"),
    "the pack refuses to adjudicate a marketplace policy",
  );
  assert(
    PROSE.includes("check the destination marketplace"),
    "and tells the seller where the real answer lives",
  );
});

Deno.test("US-2220: leisure swim is separated from pool swim", () => {
  // The composition rule bites far harder on a training suit than on resort
  // shorts. Guidance that fires on the wrong garment is worse than none.
  assert(
    PROSE.includes("Leisure swim is not pool swim"),
    "the exclusion is explicit",
  );
});

Deno.test("US-2220: neither a decoder nor a size chart is seeded", () => {
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "nothing here carries a brand-unique tag code",
  );
  assert(
    !/insert\s+into\s+public\.brand_size_charts/i.test(SQL),
    "swim splits into two sizing worlds that share no scale",
  );
});
