// US-2220: verify the ski / snowboard content (migration 00584).
//
// The category's defining problem:
//
//     THE SPEC IS A CLAIM ABOUT THE GARMENT WHEN NEW, AND EVERYTHING THAT
//     ACTUALLY FAILS IS INVISIBLE IN A PHOTOGRAPH.
//
// A snow jacket sells on two numbers — waterproofing in millimetres and
// breathability in grams — and neither can be observed on a used garment. So the
// grading question is which of two failure modes the item has, because one is a
// consumable and the other is terminal:
//
//   * DWR wears off and is RE-TREATABLE → grade as a consumable.
//   * SEAM TAPE delaminates and cannot be restored → grade as terminal.
//
// That is the same pair as golf's spikes and receptacles (00583), which is why
// both packs carry an explicit inspection instruction rather than a warning.
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
    "../../../../supabase/migrations/00584_snow_outerwear_brand_knowledge.sql",
    import.meta.url,
  ),
);

/** See scrubs-uniform-content_test.ts — phrase assertions read this, not SQL. */
const PROSE = SQL
  .replace(/^\s*--\s?/gm, " ")
  .replace(/''/g, "'")
  .replace(/\s+/g, " ");

Deno.test("US-2220: the snow aliases canonicalize", () => {
  for (const brand of ["Burton", "Spyder", "Volcom", "Obermeyer"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  assertEquals(canonicalizeBrand("burton snowboards"), "Burton");
  assertEquals(canonicalizeBrand("sport obermeyer"), "Obermeyer");
  assertEquals(canonicalizeBrand("volcom stone"), "Volcom");
});

Deno.test("US-2220: the spec is recorded as a NEW-garment claim", () => {
  // Same discipline as the scrubs finish claim (00580): carry it as a fact about
  // the model, never as a property of the used item.
  assert(
    PROSE.includes("THE SPEC IS A CLAIM ABOUT THE GARMENT WHEN NEW"),
    "the framing is stated at the top",
  );
  assert(
    PROSE.includes("THE WATERPROOF NUMBER IS A NEW-GARMENT CLAIM"),
    "and it is carried in a tell, not only in the header",
  );
  for (const unit of ["millimetres", "grams"]) {
    assert(PROSE.includes(unit), `the pack names the ${unit} axis`);
  }
});

Deno.test("US-2220: DWR is a consumable and seam tape is terminal", () => {
  // The pair that decides the grade, and the reason the pack exists.
  assert(
    PROSE.includes("DWR wearing off is a CONSUMABLE, not damage"),
    "the recoverable failure is named as recoverable",
  );
  assert(
    PROSE.includes("SEAM TAPE DELAMINATING IS TERMINAL"),
    "and the unrecoverable one as unrecoverable",
  );
  // A warning without an action is not useful — the inspection instruction is
  // the part a seller can act on.
  assert(
    PROSE.includes("TURN THE JACKET INSIDE OUT"),
    "and it says exactly what to look at",
  );
});

Deno.test("US-2220: 'critically taped' is a spec, not a defect", () => {
  // A critically taped jacket sealed only neck, shoulders and chest at the
  // factory. Reading its untaped lower seams as damage marks the garment down
  // for being what it was built as.
  assert(
    PROSE.includes("CRITICALLY TAPED\" IS A SPEC, NOT A DEFECT") ||
      PROSE.includes("critically taped one seals only"),
    "the tier distinction is recorded",
  );
  assert(
    PROSE.includes("not damage") || PROSE.includes("are not damage"),
    "and it says so in the words a grader needs",
  );
});

Deno.test("US-2220: Volcom's two categories are separated", () => {
  // A Volcom tee is a garment; a Volcom snow jacket carries a spec, taped seams
  // and a powder skirt. Applying the snow guidance to the tee is nonsense, so
  // the category has to come from the GARMENT rather than the brand.
  assert(
    PROSE.includes("IT SPANS TWO CATEGORIES AND THEY GRADE DIFFERENTLY"),
    "the crossover is flagged on the brand row",
  );
  assert(
    PROSE.includes("mean nothing on a t-shirt"),
    "and the consequence is stated concretely",
  );
});

Deno.test("US-2220: a youth grow system is design, not alteration damage", () => {
  // Extendable cuffs and hems ship that way so a garment lasts a second season.
  // Same shape as the tailoring inlay call in 00581.
  assert(
    PROSE.includes("GROW SYSTEMS, and they are a feature"),
    "the design-vs-defect call is recorded",
  );
  assert(
    PROSE.includes("let-down") || PROSE.includes("let-down seams"),
    "and it names what the grader will actually see",
  );
});

Deno.test("US-2220: no size chart, and the reason is category-specific", () => {
  assert(
    !/insert\s+into\s+public\.brand_size_charts/i.test(SQL),
    "snow outerwear is cut to layer over, so a chart would misstate the allowance",
  );
  assert(
    PROSE.includes("cut to LAYER OVER"),
    "and the reason is recorded rather than left as an omission",
  );
});

Deno.test("US-2220: no decoder is seeded", () => {
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "nothing here carries a brand-unique tag code",
  );
});
