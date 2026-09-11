// US-3329 part 2: the seller's smoke-free / pet-free statement, and the
// "not visible in these photos" rule, on both certificate read paths.
//
//   deno test --allow-net --allow-env --allow-read src/tests/cleanliness-statements_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  cleanlinessVisible,
  normalizeSellerStatements,
  parseSellerStatements,
} from "../lib/cleanliness-visibility.ts";

// The same five cases were run against the SQL expression in 00787 on the local
// stack (2026-09-11) with these results; src/test/cleanliness.test.ts runs them
// against the web copy.
export const VISIBILITY_CASES: Array<[string, unknown, boolean]> = [
  ["every photo unassessable", [{ unassessable_factors: ["odor_cleanliness"] }, { unassessable_factors: ["odor_cleanliness", "functional_elements"] }], false],
  ["one photo could judge it", [{ unassessable_factors: ["odor_cleanliness"] }, { unassessable_factors: [] }], true],
  ["field missing", [{ image_type: "front" }], true],
  ["no analyses", [], true],
  ["not an array", null, true],
];

Deno.test("cleanliness_visible matches the view's rule on every case", () => {
  for (const [name, pia, expected] of VISIBILITY_CASES) {
    assertEquals(cleanlinessVisible(pia), expected, name);
  }
});

Deno.test("seller statements: known values only, deduped, canonical order", () => {
  assertEquals(normalizeSellerStatements(["pet_free", "smoke_free", "pet_free"]), ["smoke_free", "pet_free"]);
  assertEquals(normalizeSellerStatements(["no_kids", "SMOKE_FREE "]), ["smoke_free"]);
  assertEquals(normalizeSellerStatements("pet_free,bogus"), ["pet_free"]);
  assertEquals(normalizeSellerStatements(null), []);
  const fd = new FormData();
  fd.append("seller_statements", "smoke_free");
  fd.append("seller_statements", "pet_free,evil");
  assertEquals(parseSellerStatements(fd), ["smoke_free", "pet_free"]);
});

// ── source guards ───────────────────────────────────────────────────────────

function code(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, import.meta.url))
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

Deno.test("the grading path never reads the seller's statements", () => {
  // The statement is a claim about SMELL, which the grade does not score. If it
  // ever reached a prompt it would be seller text steering a factor.
  for (const rel of ["../lib/ai-grading.ts", "../lib/grading-pipeline.ts", "../lib/quick-grade.ts"]) {
    assert(!code(rel).includes("seller_statements"), `${rel} reads seller_statements`);
  }
});

Deno.test("the edge certificate sends both fields without spreading per_image_analysis", () => {
  // Raw text: the comment stripper would eat from a "/*" inside a route string
  // like "/api/content/public/*" to the next "*/", which is most of this file.
  const src = Deno.readTextFileSync(new URL("../routes/content-public.ts", import.meta.url))
    .replace(/\r\n/g, "\n");
  assert(src.includes("seller_statements: normalizeSellerStatements("));
  assert(src.includes("cleanliness_visible: cleanlinessVisible("));
  const cols = src.match(/const CERT_REPORT_(GENESIS|EXTRA)_COLUMNS =[\s\S]*?;/g)?.join(" ") ?? "";
  assert(cols.length > 0, "cert column allowlists not found");
  assert(!cols.includes("per_image_analysis"), "per_image_analysis joined the spread report row");
});

Deno.test("submit stores the statements through the allowlist parser", () => {
  assert(code("../routes/grade.ts").includes("seller_statements: parseSellerStatements(formData),"));
});

Deno.test("00787 keeps every 00571 view column in order and appends two", () => {
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  const cols = (file: string) => {
    const sql = Deno.readTextFileSync(new URL(file, dir)).replace(/\r\n/g, "\n");
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE VIEW public.public_grade_reports AS"),
    );
    const select = body.slice(0, body.indexOf("\nFROM public.grade_reports gr"));
    // Output names: the alias after AS, else the bare gr.<col> on its own line.
    const names: string[] = [];
    for (const line of select.split("\n")) {
      const as = line.match(/\)?\s+AS\s+([a-z_0-9]+),?\s*$/i) ?? line.match(/^\s+AS\s+([a-z_0-9]+),?\s*$/i);
      // Subquery table aliases (iss, elem, e) are not output columns.
      if (as && !["iss", "elem", "e"].includes(as[1])) { names.push(as[1]); continue; }
      if (as) continue;
      const bare = line.match(/^\s+gr\.([a-z_0-9]+),?\s*$/);
      if (bare) names.push(bare[1]);
    }
    return names;
  };
  const before = cols("00571_grade_confidence_label_fn.sql");
  const after = cols("00787_seller_statements_cleanliness_visible.sql");
  assert(before.length > 30, `parsed only ${before.length} columns from 00571`);
  assertEquals(after.slice(0, before.length), before);
  assertEquals(after.slice(before.length), ["seller_statements", "cleanliness_visible"]);
});
