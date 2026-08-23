import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// US-2810: the operator SQL that arms the footwear shadow candidates.
//
// WHY THIS TEST EXISTS, and it is not hypothetical. CLAUDE.md records that every
// operator script run for the first time in this repo has had a real defect in
// it. This one was written, then checked against the migrations, and it had
// THREE: it selected `candidate_label` and `overall_delta`, which are the names
// the story's own description implies and are not the names the table has
// (`shadow_prompt_version_name` and `score_delta`), and it did not filter on
// `stage`, which 00566 added when the results table started holding both the
// composite and per-image shadows.
//
// None of those would have been caught by reading. Two would have failed
// outright on prod ("column does not exist") after the operator had already
// pasted it in; the third would have silently counted the wrong rows.
//
// Docker was down when this was written so the SQL could not be executed
// against the local stack, which is the check this substitutes for. It is
// weaker: it proves every identifier EXISTS, not that the query means what it
// says.

const ROOT = process.cwd();
const SQL = readFileSync(resolve(ROOT, "scripts/shadow-footwear-criteria.sql"), "utf8");

/** Every migration, concatenated — the schema as prod will have it. */
const MIGRATIONS = readdirSync(resolve(ROOT, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(resolve(ROOT, "supabase/migrations", f), "utf8"))
  .join("\n");

/** SQL with comments removed — a name in prose is not a reference. */
function stripComments(sql: string): string {
  return sql.replace(/^\s*--[^\n]*$/gm, "");
}

const CODE = stripComments(SQL);

describe("the footwear shadow SQL only names things that exist", () => {
  it("every public.<table> it touches is created by a migration", () => {
    const tables = new Set(
      [...CODE.matchAll(/\bpublic\.(\w+)/g)].map((m) => m[1]!),
    );
    expect(tables.size, "no table references found — the scan is broken")
      .toBeGreaterThan(0);
    for (const t of tables) {
      expect(
        MIGRATIONS.includes(`CREATE TABLE IF NOT EXISTS public.${t}`) ||
          MIGRATIONS.includes(`CREATE TABLE public.${t}`),
        `${t} is never created by any migration`,
      ).toBe(true);
    }
  });

  // The columns this script reads or writes, listed here so the check is
  // explicit about what it covers. Every one of these is a name that has to be
  // right or the operator gets an error mid-paste.
  const COLUMNS = [
    // ai_prompt_block_versions (00563 + 00566)
    "version_name", "stage", "block_key", "garment_scope", "block_text",
    "is_shadow", "shadow_sample_rate", "shadow_daily_cap", "is_active",
    "is_canary",
    // grading_shadow_results (00115 + 00566) — THE THREE THAT WERE WRONG
    "shadow_prompt_version_name", "score_delta", "tier_agreement",
    "per_factor_deltas", "vision_calls", "submission_id",
    // submissions (00001)
    "garment_category",
  ];

  it.each(COLUMNS)("%s is a real column somewhere in the schema", (col) => {
    expect(CODE, `${col} is listed as covered but the SQL never uses it`)
      .toContain(col);
    expect(
      MIGRATIONS.includes(col),
      `${col} appears in no migration — this is the defect class that shipped ` +
        `candidate_label and overall_delta`,
    ).toBe(true);
  });

  it("EVERY snake_case name the SQL uses exists in the schema", () => {
    // ⚠ THE LIST ABOVE IS NOT ENOUGH ON ITS OWN, and a sabotage proved it:
    // renaming `sum(vision_calls)` to `sum(vision_calls_total)` stayed green,
    // because `vision_calls` was still present elsewhere in the file and the
    // invented name was never looked at. A fixed list can only check the names
    // someone remembered to add to it.
    //
    // So this reads the identifiers OUT of the SQL. Aliases are stripped first
    // (they are defined by the query, not by the schema), then every remaining
    // snake_case token must appear somewhere in the migrations.
    // String literals go first: the version names being INSERTED
    // (category_criteria_sneakers_v2 and friends) are data this script creates,
    // not schema it depends on, and they are snake_case like everything else.
    const noStrings = CODE.replace(/'[^']*'/g, "''");

    const aliases = new Set(
      [...noStrings.matchAll(/\bas\s+([a-z][a-z0-9_]*)/gi)].map((m) =>
        m[1]!.toLowerCase()
      ),
    );

    // Postgres keywords and functions that look like column names.
    const SQL_WORDS = new Set([
      "on_conflict", "order_by", "group_by", "not_null", "is_not",
    ]);

    const used = new Set<string>();
    for (const m of noStrings.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
      const name = m[1]!;
      if (aliases.has(name) || SQL_WORDS.has(name)) continue;
      used.add(name);
    }
    expect(used.size, "no identifiers extracted — the scan is broken")
      .toBeGreaterThan(10);

    const missing = [...used].filter((n) => !MIGRATIONS.includes(n));
    expect(
      missing,
      `these names appear in no migration, so the operator would meet ` +
        `"column does not exist" mid-paste on prod`,
    ).toEqual([]);
  });

  it("names no column the migrations have never heard of", () => {
    // The two that were actually wrong, pinned by name so a future edit that
    // reintroduces them from the story's prose fails here rather than on prod.
    for (const wrong of ["candidate_label", "overall_delta"]) {
      expect(
        CODE.includes(wrong),
        `${wrong} is the story description's name for a column that does not ` +
          `exist; the table calls it something else`,
      ).toBe(false);
    }
  });

  it("the garment values it filters on are real enum members", () => {
    // submissions.garment_category is an ENUM, so a value outside it is not an
    // empty result — it is `invalid input value for enum`, mid-paste, on prod.
    //
    // ⚠ READS THE VALUES OUT OF THE SQL rather than checking a list written
    // here. The first version looped over a hardcoded ["sneakers","boots",
    // "sandals"] and asserted the file contained each; a sabotage that changed
    // ONE of the three sites to 'trainers' stayed green, because 'sneakers'
    // was still present at the other two and 'trainers' was never looked at.
    // Asserting an expectation is not the same as reading the artifact.
    const enumBlock = MIGRATIONS.slice(
      MIGRATIONS.indexOf("CREATE TYPE public.garment_category AS ENUM"),
    ).slice(0, 500);
    const members = new Set(
      [...enumBlock.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!),
    );
    // Later migrations add members too (neckwear, gloves), so take those as well.
    for (const m of MIGRATIONS.matchAll(
      /ALTER TYPE public\.garment_category ADD VALUE[^']*'([^']+)'/g,
    )) {
      members.add(m[1]!);
    }
    expect(members.size, "the enum block did not parse").toBeGreaterThan(10);

    // Every quoted value the SQL compares against garment_category, wherever it
    // appears: the `in (...)` lists and the garment_scope column of the insert.
    const used = new Set<string>();
    for (const m of CODE.matchAll(/garment_(?:category|scope)\s+in\s*\(([^)]*)\)/gi)) {
      for (const v of m[1]!.matchAll(/'([^']+)'/g)) used.add(v[1]!);
    }
    for (const m of CODE.matchAll(/^\s*'([a-z-]+)',\s*''/gim)) used.add(m[1]!);
    expect(used.size, "no garment values found — the extraction is broken")
      .toBeGreaterThan(2);

    for (const cat of used) {
      expect(
        members.has(cat),
        `${cat} is not a garment_category enum member — this errors on prod ` +
          `rather than returning nothing`,
      ).toBe(true);
    }
  });
});

describe("the footwear shadow SQL writes only where it says it does", () => {
  it("section 1 is the only part that writes", () => {
    // Everything from the section-2 header on is an operator READ. A write down
    // there would run every time someone checks whether the shadow is working.
    //
    // SPLIT ON THE RAW SQL, not on CODE. The section markers are comments, so
    // CODE has already removed them - the first version sliced from index -1
    // and checked a ONE-CHARACTER string for write verbs, which passes for
    // free. The length assertion below is what caught that, and it stays.
    const marker = SQL.indexOf("-- §2");
    expect(marker, "the section-2 marker is gone").toBeGreaterThan(-1);
    const readOnlyPart = stripComments(SQL.slice(marker));
    expect(readOnlyPart.length, "the read-only part is suspiciously short")
      .toBeGreaterThan(200);
    for (const verb of ["insert ", "update ", "delete ", "drop ", "alter ", "truncate "]) {
      expect(
        readOnlyPart.toLowerCase().includes(verb),
        `a ${verb.trim()} appears after §2, which is meant to be read-only`,
      ).toBe(false);
    }
  });

  it("it never activates the candidate it is shadowing", () => {
    // The whole safety claim of US-2810 AC4. is_active or is_canary set true on
    // one of these rows makes the candidate a champion and starts moving
    // published grades, which is the one thing this story must not do.
    expect(CODE).toContain("is_active          = false");
    expect(CODE).toContain("is_canary          = false");
    expect(CODE.toLowerCase()).not.toContain("is_active = true");
    expect(CODE.toLowerCase()).not.toContain("is_canary = true");
  });

  it("it does not touch the feature flag it is meant to leave alone", () => {
    expect(CODE).not.toContain("GRADING_CATEGORY_CRITERIA_V2");
  });
});
