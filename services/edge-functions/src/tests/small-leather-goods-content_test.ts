// US-2221: verify the small-leather-goods content (migration 00577). The last
// of the four accessory packs.
//
// The story asked for SLG "as a distinct class from handbags". What makes it
// one, and what this file protects:
//
//   1. A WALLET CARRIES LESS THAN A BAG, AND WHAT IT CARRIES WEARS OFF WHERE THE
//      HAND HOLDS IT. 00468's thesis was that a bag carries less than a garment.
//      A wallet has no care label, no hangtag and no creed patch — only an
//      emboss on a panel that is gripped daily. So IDENTIFIABILITY DEGRADES WITH
//      CONDITION, a coupling that exists nowhere else in this KB.
//   2. THE CATEGORY'S NAME IS WRONG. Two of the four make their flagship from
//      METAL — The Ridge is aluminium/titanium/carbon fibre, Secrid's
//      Cardprotector is anodised aluminium. A leather rubric has nothing to say
//      about either, so the pack names the real failure modes instead.
//   3. PATINA IS THE PRODUCT, NOT WEAR, on Bosca's Old Leather. Grading it as
//      soiling penalises the item for doing what it was designed to do — the
//      same class of error as a Persol Meflecto stem read as a loose arm.
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
    "../../../../supabase/migrations/00577_small_leather_goods_brand_knowledge.sql",
    import.meta.url,
  ),
);

/**
 * The migration's PROSE: comment markers stripped, whitespace collapsed.
 *
 * ⚠ PHRASE assertions read THIS; only statement shapes (`insert into …`) read
 * raw `SQL`. Migration headers hard-wrap at ~79 columns, so any phrase worth
 * asserting is one edit away from being split across two `--` lines — which
 * broke a content test three times in one day, every time on a migration that
 * was correct. Rewrapping a comment to satisfy a matcher makes the migration's
 * formatting load-bearing; normalising here makes the test read what a human
 * reads. PROSE is a superset of SQL, so this can only ever be more permissive.
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


Deno.test("US-2221: the SLG aliases canonicalize", () => {
  for (const brand of ["Bellroy", "The Ridge", "Secrid", "Bosca"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  for (const spelling of ["ridge", "Ridge Wallet", "the ridge", "THE RIDGE"]) {
    assertEquals(canonicalizeBrand(spelling), "The Ridge", `${spelling} resolves`);
  }
  assertEquals(canonicalizeBrand("Hugo Bosca"), "Bosca");
  assertEquals(canonicalizeBrand("secrid"), "Secrid");
});

Deno.test("US-2221: 'The Ridge' is never minted out of prose", () => {
  // A phrase before it is a brand — a trail, a mountain, a neighbourhood — and
  // at 9 characters it would beat a real "Nike" (4) in the same title.
  assertEquals(
    detectBrandInText("Nike tee, Blue Ridge Parkway graphic, size L"),
    "Nike",
    "the real brand wins; a ridge is a landform",
  );
  assertEquals(
    detectBrandInText("Sweatshirt from the ridge trail gift shop"),
    null,
    "prose alone must not mint the wallet house",
  );
  // Still reachable BY TAG, which is what the eBay Brand aspect reads.
  assertEquals(canonicalizeBrand("The Ridge"), "The Ridge");
  assert(isKnownBrand("Ridge Wallet"));

  // The other three are not excluded — none is an ordinary English word.
  assertEquals(detectBrandInText("Bellroy Slim Sleeve wallet, navy"), "Bellroy");
  assertEquals(detectBrandInText("Secrid Miniwallet, black"), "Secrid");
});

Deno.test("US-2221: the metal wallets are not graded as leather", () => {
  // The pack's headline correction. A leather rubric applied to an aluminium
  // object invents defects that cannot exist and misses the ones that can.
  assert(
    PROSE.includes("IT IS NOT LEATHER"),
    "The Ridge's row says so where a reader will hit it",
  );
  for (const material of ["aluminium", "titanium", "carbon fibre"]) {
    assert(
      PROSE.toLowerCase().includes(material.toLowerCase()),
      `the pack names ${material} as a body material`,
    );
  }
  // And it names what to grade INSTEAD, which is the part that makes the
  // correction actionable rather than merely a warning.
  for (const failure of ["anodising", "elastic", "mechanism"]) {
    assert(
      PROSE.toLowerCase().includes(failure),
      `the pack names the real failure mode: ${failure}`,
    );
  }
});

Deno.test("US-2221: patina is recorded as design, not as a defect", () => {
  // Bosca's signature line is sold ON its patina. A tell that let this be graded
  // as soiling would mark the item down for doing its job.
  assert(
    PROSE.includes("PATINA ON OLD LEATHER IS THE PRODUCT, NOT WEAR"),
    "the design-vs-defect call is stated, not implied",
  );
  // The tell must also say what SHOULD be graded, or it only removes a signal.
  const bosca = SQL.slice(SQL.indexOf("'bosca', 'Bosca'"));
  for (const real of ["cracking", "split spine", "stretched slots"]) {
    assert(bosca.includes(real), `and it redirects to a real defect: ${real}`);
  }
});

Deno.test("US-2221: the wallet-specific wear points are recorded", () => {
  // Wear on a wallet is concentrated and predictable, unlike a garment's. Four
  // places carry nearly all of it, and the bill-compartment lining is the one
  // most often hidden in listing photos because nobody opens it.
  for (const point of ["SPINE", "CARD SLOTS", "CORNERS", "BILL COMPARTMENT"]) {
    assert(PROSE.includes(point), `the pack names the wear point: ${point}`);
  }
});

Deno.test("US-2221: identifiability degrades with condition, and it is written down", () => {
  // The coupling that makes SLG a distinct class: a wallet's only mark is on the
  // panel the hand grips. A blank-looking wallet is evidence of USE, not of a
  // no-name item — and a grader that does not know that will read an unmarked
  // wallet as unbranded.
  assert(
    PROSE.includes("IDENTIFIABILITY DEGRADES WITH CONDITION"),
    "the coupling is stated as the reason SLG is its own class",
  );
  assert(
    PROSE.includes("Absence of a mark is not evidence of a no-name wallet"),
    "and the operational consequence is spelled out in a tell",
  );
});

Deno.test("US-2221: a wallet does not inherit its house's bag grading", () => {
  // Coach, Louis Vuitton, Gucci, Dooney & Bourke and Fossil all have packs, all
  // written around BAGS. Their small leather goods sit on a different ladder.
  assert(
    PROSE.includes("A HOUSE'S WALLET IS NOT ITS BAG"),
    "the distinct-class rule is stated operationally, not just asserted",
  );
});

Deno.test("US-2221: neither a decoder nor a size chart is seeded", () => {
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "no decoder — the model name is on the box, never on the object",
  );
  assert(
    !/insert\s+into\s+public\.brand_size_charts/i.test(SQL),
    "no size chart — a wallet has no size",
  );
});
