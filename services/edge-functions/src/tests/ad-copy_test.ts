// Unit tests for the pure ad-copy guardrails + export formatting (US-1073).
// ad-copy.ts has no AI/DB deps, so this runs with no fixtures:
//   deno test src/tests/ad-copy_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  AD_LIMITS,
  adCreativeToAdsEditorCsv,
  adCreativeToCsv,
  enforceKeywords,
  enforceLines,
  normalizeLine,
  violatesPolicy,
} from "../lib/ad-copy.ts";

Deno.test("enforceLines drops over-limit, empty, and duplicate candidates", () => {
  const lines = enforceLines(
    [
      "Grade Your Closet Fast", // ok (22)
      "This headline is absolutely far too long to ever fit", // > 30 chars
      "Grade your closet fast", // dup (case-insensitive)
      "  ", // empty after trim
      "Trusted Condition Grades", // ok (24)
    ],
    AD_LIMITS.google_ads.headlineMaxChars,
    AD_LIMITS.google_ads.headlineMax,
  );
  assertEquals(lines.length, 2);
  assertEquals(lines[0]?.text, "Grade Your Closet Fast");
  assertEquals(lines[0]?.chars, 22);
  // every kept line is within the limit
  assert(lines.every((l) => l.chars <= AD_LIMITS.google_ads.headlineMaxChars));
});

Deno.test("enforceLines caps the number of returned lines", () => {
  const many = Array.from({ length: 40 }, (_, i) => `Headline number ${i}`);
  const lines = enforceLines(many, 30, AD_LIMITS.google_ads.headlineMax);
  assertEquals(lines.length, AD_LIMITS.google_ads.headlineMax);
});

Deno.test("violatesPolicy rejects superlatives, shouting, and repeated punctuation", () => {
  assert(violatesPolicy("The #1 grading tool"));
  assert(violatesPolicy("Best ever resale grades"));
  assert(violatesPolicy("GRADE NOW")); // all caps
  assert(violatesPolicy("Grade now!!"));
  assert(!violatesPolicy("Grade your closet with confidence"));
  assert(!violatesPolicy("Free condition certificate")); // single word caps-free
});

Deno.test("normalizeLine collapses whitespace and strips wrapping quotes", () => {
  assertEquals(normalizeLine('  "Grade   your   closet"  '), "Grade your closet");
  assertEquals(normalizeLine("“Trusted grades”"), "Trusted grades");
});

Deno.test("enforceKeywords lowercases, de-dupes, drops over-limit terms", () => {
  const kws = enforceKeywords(
    ["Used Clothing Grade", "used clothing grade", "a-keyword-far-too-long-to-fit-here", "resale score"],
    AD_LIMITS.apple_search_ads.keywordMaxChars,
    AD_LIMITS.apple_search_ads.keywordMax,
  );
  assertEquals(kws, ["used clothing grade", "resale score"]);
});

Deno.test("adCreativeToCsv emits a header + one row per asset, RFC-4180 quoted", () => {
  const csv = adCreativeToCsv(
    "google_ads",
    {
      headlines: [{ text: "Grade, fast", chars: 11 }],
      descriptions: [{ text: "Trusted condition grades", chars: 24 }],
    },
    ["used clothing grade"],
  );
  const rows = csv.split("\r\n");
  assertEquals(rows.length, 3); // header + 1 headline + 1 description
  assertEquals(rows[0], "platform,asset_type,text,chars,source_keywords");
  // the comma inside "Grade, fast" forces quoting
  assert(rows[1]?.includes('"Grade, fast"'));
});

Deno.test("adCreativeToAdsEditorCsv lays headlines/descriptions across columns", () => {
  const csv = adCreativeToAdsEditorCsv("google_ads", {
    headlines: [
      { text: "H1", chars: 2 },
      { text: "H2", chars: 2 },
    ],
    descriptions: [{ text: "D1", chars: 2 }],
  });
  const [header, values] = csv.split("\r\n");
  const cols = header?.split(",") ?? [];
  // 15 headline + 4 description columns
  assertEquals(cols.length, AD_LIMITS.google_ads.headlineMax + AD_LIMITS.google_ads.descriptionMax);
  assertEquals(cols[0], "Headline 1");
  const vals = values?.split(",") ?? [];
  assertEquals(vals[0], "H1");
  assertEquals(vals[1], "H2");
  assertEquals(vals[2], ""); // Headline 3 empty
  assertEquals(vals[AD_LIMITS.google_ads.headlineMax], "D1"); // first description col
});
