// US-2220: verify the scrubs / uniform content (migration 00580).
//
// The story calls scrubs "one of the highest-volume resale categories" and the
// KB had no coverage. What this file protects is the three things that make
// uniform a different category rather than more apparel:
//
//   1. IT IS SOLD AS SEPARATES THAT SIZE INDEPENDENTLY. A top and a pant are two
//      products with two size runs. "Size M" says half of what a buyer needs,
//      which is why no single chart per brand is seeded.
//   2. COLOUR IS COMPLIANCE, NOT TASTE. Hospitals mandate scrub colour by role
//      and unit, so colour is the primary search term and a discontinued colour
//      carries a premium.
//   3. THE DEFECTS ARE OCCUPATIONAL AND TERMINAL. Bleach, betadine and blood,
//      on a garment that has to read as clean in a clinical setting.
//
// ⚠ AND THE CONTRAST WITH 00579, WHICH SHIPPED THE SAME DAY, IS THE REASON
// PER-CATEGORY GUIDANCE EXISTS AT ALL: in vintage tees the fade IS the premium;
// in scrubs the identical observation is the failure. Same photograph, opposite
// reading.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { canonicalizeBrand, isKnownBrand } = await import(
  "../lib/brand-normalize.ts"
);

const SQL = await Deno.readTextFile(
  new URL(
    "../../../../supabase/migrations/00580_scrubs_uniform_brand_knowledge.sql",
    import.meta.url,
  ),
);

/**
 * The migration's PROSE with comment markers stripped and whitespace collapsed.
 *
 * ⚠ USE THIS FOR EVERY PHRASE ASSERTION, and use raw `SQL` only for statement
 * shapes like `insert into ...`. Migration headers are hard-wrapped at ~79
 * columns, so any asserted phrase long enough to be worth asserting is one edit
 * away from being split across two `--` lines. That broke a content test three
 * times in one day (00577's "CARD SLOTS", 00579's "CANNOT ATTRIBUTE SCREEN
 * STARS", and this file's Careismatic negative) — every time the SQL was
 * correct and the assertion was reading a line break as a missing sentence.
 *
 * Rewrapping the comment to satisfy a matcher is the wrong direction: it makes
 * the migration's formatting load-bearing. Normalising here makes the test read
 * what a human reads.
 */
// ⚠ The `''` step unescapes SQL's doubled apostrophe: inside a string literal
// `STORY''S` is `STORY'S` in the database, so a matcher reading the raw file
// sees neither form. Same class as the line-wrap problem — the file's ENCODING
// is not its content. PROSE stays a superset of SQL, so this is only ever more
// permissive.
const PROSE = SQL
  .replace(/^\s*--\s?/gm, " ")
  .replace(/''/g, "'")
  .replace(/\s+/g, " ");

Deno.test("US-2220: the scrub aliases canonicalize", () => {
  for (const brand of ["FIGS", "Cherokee Uniforms", "WonderWink"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  assertEquals(canonicalizeBrand("wearfigs"), "FIGS");
  assertEquals(canonicalizeBrand("cherokee scrubs"), "Cherokee Uniforms");
  assertEquals(canonicalizeBrand("wink scrubs"), "WonderWink");
});

Deno.test("US-2220: 'Dickies' on a scrub top is not the workwear house", () => {
  // THE COLLISION THIS PACK FOUND, and it is with a brand the map has carried
  // since 00389. Careismatic publishes Dickies Medical — the Dickies name under
  // licence on scrubs — while `dickies` points at the workwear house whose pack,
  // tells and sizing are about work pants. A fold would hand a scrub top the
  // wrong chart. Marc-by-Marc-Jacobs rule: a shared name is not a shared brand.
  assertEquals(canonicalizeBrand("Dickies Medical"), "Dickies Medical");
  assertEquals(canonicalizeBrand("dickies scrubs"), "Dickies Medical");
  assert(
    canonicalizeBrand("Dickies Medical") !== "Dickies",
    "the medical line must NOT fold onto the workwear house",
  );
  // And the workwear house is undisturbed.
  assertEquals(canonicalizeBrand("dickies"), "Dickies");
});

Deno.test("US-2220: a bare 'Cherokee' stays a passthrough", () => {
  // A people and a place before it is a label, and the name has been licensed
  // across general apparel. A scrub pack must not claim those garments.
  assert(!isKnownBrand("cherokee"), "a bare 'cherokee' is not the scrub line");
  assertEquals(canonicalizeBrand("Cherokee"), "Cherokee");
  // A bare "wink" is an ordinary English word and is likewise absent.
  assert(!isKnownBrand("wink"), "a bare 'wink' is a verb");
});

Deno.test("US-2220: separates sizing is stated, and no chart pretends otherwise", () => {
  assert(
    PROSE.includes("SOLD AS SEPARATES THAT SIZE INDEPENDENTLY"),
    "the reason there is no chart is stated, not left as an omission",
  );
  assert(
    !/insert\s+into\s+public\.brand_size_charts/i.test(SQL),
    "one chart per brand would flatten two independent size runs",
  );
});

Deno.test("US-2220: colour is recorded as compliance, not decoration", () => {
  assert(
    PROSE.includes("COLOUR IS COMPLIANCE, NOT TASTE"),
    "the category's primary search term is named for what it is",
  );
});

Deno.test("US-2220: occupational damage is graded as terminal", () => {
  // Unlike almost everything else this KB grades, these cannot be discounted
  // into acceptability — the garment has to read as clean in a clinical setting.
  for (const defect of ["bleach", "betadine", "blood"]) {
    assert(
      PROSE.toLowerCase().includes(defect),
      `the pack names the occupational defect: ${defect}`,
    );
  }
  assert(
    PROSE.includes("closer to a hole than to a stain"),
    "and says how hard to grade it",
  );
});

Deno.test("US-2220: a finish claim never travels onto a used garment", () => {
  // Antimicrobial and fluid-repellent finishes are applied treatments that
  // degrade with laundering and cannot be verified second-hand. Carrying the
  // brand's claim onto a resale listing would be advertising an entitlement the
  // item may no longer have.
  assert(
    PROSE.includes("A PERFORMANCE FINISH CLAIM DOES NOT SURVIVE RESALE"),
    "the disclosure discipline is stated in a tell",
  );
});

Deno.test("US-2220: WonderWink's ownership is deliberately not claimed", () => {
  // Checked rather than assumed: WonderWink does NOT appear in Careismatic's
  // published portfolio, so the obvious guess that every large scrub label shares
  // a parent is wrong. An unsourced corporate relationship is the same class of
  // invention as an unsourced era.
  assert(
    PROSE.includes("ITS OWNERSHIP IS NOT CLAIMED HERE"),
    "the absence is recorded as a decision",
  );
  assert(
    PROSE.includes("WonderWink is NOT in Careismatic's published portfolio"),
    "and the checkable negative that produced it is written down",
  );
});

Deno.test("US-2220: no decoder — a line name is a name", () => {
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "the line is printed as words, which is the Rag & Bone 'Fit 2' refusal",
  );
});
