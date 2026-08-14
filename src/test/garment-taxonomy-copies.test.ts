import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GARMENT_CATEGORIES, GARMENT_TYPES } from "@/lib/constants";

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
