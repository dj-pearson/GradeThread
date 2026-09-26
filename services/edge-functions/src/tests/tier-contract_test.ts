// US-3536: every place that names a tier for a score uses the real bands.
import "./_env.ts";
import { assert } from "@std/assert";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

Deno.test("US-3536: the API sandbox derives overall and tier from the real formula", () => {
  const api = read("../routes/api-v1.ts");
  assert(
    !api.includes("SANDBOX_TIERS"),
    "the sandbox's own tier table is back",
  );
  const fn = api.slice(
    api.indexOf("function sandboxGrade("),
    api.indexOf("function sandboxGrade(") + 2000,
  );
  assert(fn.includes("const overall = computeWeightedOverall(factors);"));
  assert(fn.includes("const tier = scoreToGradeTier(overall);"));
});

Deno.test("US-3536: 00844 uses the real tier floors in finances_dashboard", () => {
  const sql = read(
    "../../../../supabase/migrations/00844_finances_tier_bands.sql",
  );
  for (
    const line of [
      "grade_value >= 10 then 'NWT'",
      "grade_value >= 9 then 'NWOT'",
      "grade_value >= 8 then 'Excellent'",
      "grade_value >= 5 then 'Fair'",
    ]
  ) {
    assert(sql.includes(line), line);
  }
  assert(!sql.includes("grade_value >= 9.5"));
});
