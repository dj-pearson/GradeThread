// US-2220 AC4: verify the vintage / band-tee content (migration 00579).
//
// The first pack in the corpus built around tag_eras rather than styles, and the
// three things that makes true are what this file protects:
//
//   1. THE FOUR "BRANDS" ARE NOT THE BRAND ON THE SHIRT. A band tee's
//      seller-facing brand is the BAND; these are the BLANK MAKERS whose tag is
//      sewn into the collar. They date a shirt and never price one.
//   2. THE GRADING RUNS BACKWARDS HERE. Screen Stars blanks are 50/50 cotton-poly:
//      washing fades the cotton and spares the polyester, producing the thin,
//      soft, translucent shirt the category is bought FOR. A rubric built for
//      crispness reads a 9 as a 4. This is the Bosca patina call (00577) with far
//      higher stakes, because here it is most of the grade.
//   3. RN 13765 CANNOT ATTRIBUTE SCREEN STARS. It is real and it is on the tag —
//      and it belongs to the PARENT (Union Underwear / Fruit of the Loom), whose
//      generic 1970s blanks carry it too. The URBN OB###### refusal with a
//      corroborating page.
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
    "../../../../supabase/migrations/00579_vintage_tee_blanks_brand_knowledge.sql",
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


Deno.test("US-2220: the blank-maker aliases canonicalize", () => {
  for (const brand of ["Screen Stars", "Brockum", "Giant", "Winterland"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  assertEquals(canonicalizeBrand("screen stars"), "Screen Stars");
  // The sub-line resolves to the house — a seller reading "Screen Stars Best"
  // off a collar means Screen Stars.
  assertEquals(canonicalizeBrand("Screen Stars Best"), "Screen Stars");
  assertEquals(canonicalizeBrand("Giant by Tultex"), "Giant");
  assertEquals(canonicalizeBrand("brockum group"), "Brockum");
});

Deno.test("US-2220: a bare 'Tultex' must not resolve to Giant", () => {
  // Tultex is the PARENT that made Giant and it printed its own blanks under its
  // own name. Folding it would be the parent-attributes-a-sibling error the
  // decoder bar refuses, in alias form.
  assert(!isKnownBrand("tultex"), "a bare 'tultex' is the parent, not the sub-brand");
  assert(canonicalizeBrand("Tultex") !== "Giant");
});

Deno.test("US-2220: 'Giant' is never minted out of prose", () => {
  // An ordinary English adjective that clothing copy reaches for constantly, and
  // at 5 characters it beats a real "Nike" (4) on longest-first ordering.
  assertEquals(
    detectBrandInText("Nike tee with a giant swoosh logo, size L"),
    "Nike",
    "the real brand wins; 'giant' is an adjective here",
  );
  assertEquals(
    detectBrandInText("Vintage tee with a giant floral print"),
    null,
    "prose alone must not mint the blank maker",
  );
  // Reachable BY TAG, which is what the collar read produces.
  assertEquals(canonicalizeBrand("Giant"), "Giant");
  // The other three are not excluded — none is an ordinary word, and a prose
  // mention genuinely does mean the blank.
  assertEquals(detectBrandInText("Screen Stars Best single stitch tee"), "Screen Stars");
  assertEquals(detectBrandInText("Brockum tour tee, 1991"), "Brockum");
});

Deno.test("US-2220 AC4: the pack is built on tag_eras, not on styles", () => {
  // The AC's actual instruction: seed around tag_eras "because that IS the
  // identity signal in the category". So the eras must outnumber the styles.
  const eras = [...SQL.matchAll(/\{"era":/g)].length;
  const styles = [...SQL.matchAll(/^\s+\('(?:screenstars|brockum|giant|winterland)',\s+'/gm)].length;
  assert(eras >= 6, `expected the pack to be era-heavy, saw ${eras} eras`);
  assert(
    eras > styles,
    `eras (${eras}) must outnumber styles (${styles}) — that is what "built on tag_eras" means`,
  );
});

Deno.test("US-2220: every era is cited and none is over-confident", () => {
  // Migration 00572 enforces the citation in the database. The CONFIDENCE CEILING
  // is this pack's own discipline: the sourcing is specialist collector
  // reference, not the makers' own statements — most of these companies no
  // longer exist to publish anything. Cited but not authoritative, so these are
  // prompt reference rather than publishable dating claims.
  const eras = [...SQL.matchAll(/\{"era":[^}]*\}/g)].map((m) => m[0]);
  assert(eras.length >= 6, `expected the seeded eras, saw ${eras.length}`);
  for (const era of eras) {
    assert(/"source_url":"https?:\/\//.test(era), `an era must cite a source: ${era.slice(0, 60)}`);
    const conf = Number(/"confidence":([\d.]+)/.exec(era)?.[1] ?? "1");
    assert(
      conf <= 0.6,
      `collector-reference sourcing caps confidence at 0.6, saw ${conf}`,
    );
  }
});

Deno.test("US-2220: the grading inversion is stated and points at the real defects", () => {
  // The most consequential fact in the pack. A vintage tee graded on crispness
  // reads a 9 as a 4.
  assert(
    PROSE.includes("THE WEAR IS THE PRODUCT"),
    "the inversion is stated where a reader will hit it",
  );
  assert(
    PROSE.includes("THE THINNESS IS THE PRODUCT, NOT THE DAMAGE"),
    "and it is carried in a tell, not only in the header comment",
  );
  // Removing a signal without replacing it just leaves the grader blind, so the
  // pack must also name what genuinely IS a defect here.
  for (const real of ["holes", "stains", "collar"]) {
    assert(
      PROSE.toLowerCase().includes(real),
      `and it redirects to a real defect: ${real}`,
    );
  }
});

Deno.test("US-2220: a blank tag is a dating input, not a vintage switch", () => {
  // Modern and reissued blanks exist and reprints of 90s graphics are common.
  // Nothing here may flip a shirt into vintage grading on the collar alone.
  assert(
    PROSE.includes("A GIANT TAG DOES NOT MAKE A SHIRT VINTAGE"),
    "the pack refuses to let a tag decide the category",
  );
});

Deno.test("US-2220 AC5: RN 13765 is refused, and no decoder is seeded", () => {
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "no decoder — the RN belongs to the parent",
  );
  assert(PROSE.includes("RN 13765"), "the refusal names the actual number");
  assert(
    PROSE.includes("CANNOT ATTRIBUTE SCREEN STARS"),
    "and states the conclusion rather than implying it",
  );
  // No size chart either, and for a reason specific to the category.
  assert(
    !/insert\s+into\s+public\.brand_size_charts/i.test(SQL),
    "no size chart — four decades of washing destroyed the precision",
  );
});
