import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GARMENT_CATEGORIES, GARMENT_TYPES, ITEM_CATEGORIES } from "@/lib/constants";

// US-2571. US-2224 (migration 00570) added `neckwear` and `gloves` to the
// garment taxonomy. It reached src/lib/constants.ts, src/types/database.ts, the
// DB enum and the buyer surfaces — and NONE of the six other places that keep
// their own copy of the same list.
//
// The copies are not all equal in consequence, which is why this is one guard
// and not six:
//
//   ai-extract.ts        the extraction PROMPT, the model's JSON-schema enum,
//                        and the validation allowlist. A missing value is not a
//                        rejected answer, it is an answer the model was never
//                        permitted to give — so a tie came back as "other" and
//                        got graded on the clothing rubric. This is the copy
//                        that kept the original defect alive.
//   grade.ts / api-v1.ts request validators. A missing value 400s a caller who
//                        sent a value the database would have accepted.
//   openapi-spec.ts      the published API contract. Wrong here means every
//                        integrator codegens an enum that cannot express a tie.
//   garment-info-form    the web submission form. A seller filing a tie had no
//                        option to pick but "Other".
//   category-criteria    the DENO GUARD's own mirror, which is why nothing went
//                        red for the two releases in between.
//
// The edge is a separate Deno project and cannot import the frontend module, so
// the copies exist for a real reason. What they must not do is DIVERGE, and
// that is a thing a test can hold even when an import cannot.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * Pull a `const NAME = [ ... ]` array literal out of a source file.
 *
 * Comments are stripped BEFORE the strings are matched. The source list carries
 * a US-2224 note explaining why the value is "neckwear" rather than "tie", and
 * both of those words are quoted — a bare string match reads the prose as
 * taxonomy. The first draft of this parser did exactly that and invented a
 * category called `tie`.
 */
function arrayLiteral(src: string, name: string): string[] {
  const re = new RegExp(`(?:export )?const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`);
  const block = re.exec(src);
  if (!block) throw new Error(`no array literal named ${name}`);
  const body = block[1]!.replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

// Every file that keeps its own copy of the two lists, and what it costs when
// the copy is stale. Adding a seventh copy means adding it here.
const CATEGORY_COPIES = [
  "services/edge-functions/src/lib/ai-extract.ts",
  "services/edge-functions/src/routes/grade.ts",
  "services/edge-functions/src/routes/api-v1.ts",
  "services/edge-functions/src/lib/openapi-spec.ts",
] as const;

const TYPE_COPIES = CATEGORY_COPIES;

const FORM = "src/components/submission/garment-info-form.tsx";
const DENO_GUARD = "services/edge-functions/src/tests/category-criteria_test.ts";
const CRITERIA = "services/edge-functions/src/lib/ai-grading.ts";

describe("every copy of GARMENT_CATEGORIES matches the source (US-2571 AC4)", () => {
  it.each(CATEGORY_COPIES)("%s", (rel) => {
    expect(arrayLiteral(read(rel), "GARMENT_CATEGORIES")).toEqual([
      ...GARMENT_CATEGORIES,
    ]);
  });

  it.each(TYPE_COPIES)("%s GARMENT_TYPES", (rel) => {
    // AC5 asked for this list to be checked too. It happened to be in sync on
    // all four, which is luck rather than a property: it is in sync because
    // nobody has added a garment TYPE since, not because anything checks.
    expect(arrayLiteral(read(rel), "GARMENT_TYPES")).toEqual([...GARMENT_TYPES]);
  });
});

// ── US-2797: the OTHER dimension migration 00570 widened ────────────────────
//
// The guard above was written after `neckwear` and `gloves` reached six copies
// of the garment lists and not the seventh. The same migration ALSO added
// `headwear` to item_category, and that half got no guard at all — so it went
// stale in four production files for two weeks while a headwear rubric, photo
// profile and measurement template sat built and unreachable.
//
// The four copies do not fail the same way, which is why each is named:
//
//   ai-extract.ts        the extraction PROMPT and the model's JSON-schema
//                        enum. A missing value is an answer the model was
//                        never permitted to give, so a hat came back as
//                        'accessories' — the exact folding US-2223 split the
//                        category to prevent.
//   sheet-sync.ts        rejects the cell with an error AND builds the seller's
//                        Google Sheets dropdown from the list, so a valid
//                        category cannot even be picked.
//   inventory-import.ts  feeds oneOf(), which returns null rather than
//                        erroring. An import silently DROPS the category.
//   import-mapping.ts    now reads ITEM_CATEGORIES directly, so it has no copy
//                        left to go stale. Asserted below, not assumed.
//
// Two of these were stale by THREE more values (jewelry/bags/accessories, from
// migration 00230) before headwear was ever added — so this is not one slip, it
// is an unguarded axis.
const ITEM_CATEGORY_COPIES = [
  ["services/edge-functions/src/lib/ai-extract.ts", "ITEM_CATEGORIES"],
  ["services/edge-functions/src/lib/sheet-sync.ts", "ITEM_CATEGORY_VALUES"],
  ["services/edge-functions/src/lib/inventory-import.ts", "ITEM_CATEGORY_VALUES"],
] as const;

describe("every copy of ITEM_CATEGORIES matches the source (US-2797)", () => {
  it.each(ITEM_CATEGORY_COPIES)("%s / %s", (rel, name) => {
    // Sorted-set comparison, unlike the garment lists above: these three copies
    // order for their own reasons (a prompt reads best most-specific-first, a
    // spreadsheet dropdown reads best alphabetically) and forcing one order
    // would be this guard dictating presentation. Membership is the contract.
    expect([...arrayLiteral(read(rel), name)].sort()).toEqual(
      [...ITEM_CATEGORIES].sort(),
    );
  });

  it("import-mapping keeps no list of its own to go stale", () => {
    const src = read("src/lib/import-mapping.ts");
    expect(src).toContain("ITEM_CATEGORIES");
    // The tell of the copy this story removed.
    expect(src).not.toMatch(/"clothing",\s*"shoes",\s*"watches"/);
  });

  it("the extraction prompt does not route a hat to accessories", () => {
    // The enum alone is not enough. The prompt named the wrong category in
    // words, and a model told in prose to pick 'accessories' will pick it even
    // once 'headwear' becomes available.
    const src = read("services/edge-functions/src/lib/ai-extract.ts");
    expect(src).not.toContain("a hat/belt/sunglasses sold on its own is 'accessories'");
    expect(src).toMatch(/hat\/cap\/beanie[^\n]*'headwear'/);
  });

  it("every item category the classifier can return has a photo profile", () => {
    // The point of the whole dimension: item_category picks the rubric, the
    // photo profile and the measurement template. A value the classifier can
    // emit with no profile behind it gives the seller the wrong slots.
    //
    // READ THE REGISTRY KEYS, not the file text. A whole-file `toContain` would
    // be satisfied by the category's name appearing in any comment — including
    // the ones this very commit added explaining the bug — which is a guard
    // that passes because of its own documentation.
    const src = read("services/edge-functions/src/lib/photo-profiles.ts");
    const block =
      /export const PHOTO_PROFILES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
    expect(block, "PHOTO_PROFILES registry not found").toBeTruthy();
    const body = block![1]!.replace(/\/\/[^\n]*/g, "");
    const keys = [...body.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]!);

    // Guards the guard: a renamed registry would empty this and pass vacuously.
    expect(keys.length).toBeGreaterThanOrEqual(ITEM_CATEGORIES.length);

    for (const c of ITEM_CATEGORIES) {
      expect(keys, `no photo profile keyed "${c}"`).toContain(c);
    }
  });
});

describe("the submission form offers the whole taxonomy", () => {
  it("groups every category exactly once, and invents none", () => {
    const src = read(FORM);
    const block = /const CATEGORY_BY_TYPE[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
    expect(block, "CATEGORY_BY_TYPE not found").toBeTruthy();
    const body = block![1]!.replace(/\/\/[^\n]*/g, "");

    const grouped = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    // Sorted-set comparison rather than order: the form deliberately orders for
    // a dropdown, so order is its business. Membership is not.
    expect([...grouped].sort()).toEqual([...GARMENT_CATEGORIES].sort());
    expect(grouped.length, "a category is grouped under two types").toBe(
      new Set(grouped).size,
    );

    // Every garment TYPE gets a group, or picking that type yields an empty
    // dropdown and the form silently dead-ends.
    for (const t of GARMENT_TYPES) {
      expect(body, `no category group for garment type "${t}"`).toMatch(
        new RegExp(`\\b${t}:`),
      );
    }
  });

  it("shows the two US-2224 values a seller could not pick", () => {
    const src = read(FORM);
    expect(src).toContain('"neckwear"');
    expect(src).toContain('"gloves"');
  });
});

describe("the edge guard reads the source instead of copying it", () => {
  it("has no hand-typed category list of its own", () => {
    const src = read(DENO_GUARD);
    // The tell of the copy this story removed: the opening run of the list
    // written out as literals. It carried a comment claiming it would fail if
    // the two diverged, and it could not — it WAS the other side of the
    // comparison.
    expect(src).not.toMatch(/"t-shirt",\s*\n?\s*"shirt",\s*\n?\s*"blouse"/);
    expect(src).toContain("src/lib/constants.ts");
    expect(src).toContain("Deno.readTextFileSync");
  });
});

describe("grading criteria cover the widened taxonomy (US-2571 AC5)", () => {
  it("names neckwear and gloves in the gated criteria map", () => {
    const src = read(CRITERIA);
    const v2 = src.slice(
      src.indexOf("const GARMENT_CATEGORY_CRITERIA_V2"),
    );
    const body = v2.slice(0, v2.indexOf("\n};"));
    for (const c of ["neckwear", "gloves"]) {
      expect(body, `${c} has no criteria entry`).toContain(`  ${c}:`);
    }
  });

  it("keeps the design-vs-defect voice in both new entries", () => {
    // The same property category-criteria_test.ts asserts on the edge side.
    // Repeated here because this suite runs on every web change and that one
    // needs Deno — a rubric entry that only lists defects reproduces the bug
    // the block exists to fix.
    const src = read(CRITERIA);
    for (const c of ["NECKWEAR", "GLOVES"]) {
      const at = src.indexOf(`${c}-SPECIFIC:`);
      expect(at, `${c}-SPECIFIC: not found`).toBeGreaterThan(0);
      const entry = src.slice(at, src.indexOf('",\n', at));
      expect(entry, `${c} never says what is INTENTIONAL`).toContain(
        "INTENTIONAL",
      );
    }
  });
});
