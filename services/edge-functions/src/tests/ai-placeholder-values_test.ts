// Placeholder model output must be treated as ABSENT, never as an answer.
//
// Every extract prompt says "omit any field you cannot support", and the model
// usually obeys — but when it doesn't it writes "<UNKNOWN>" (confidence 0)
// instead of leaving the slot out. Nothing downstream could tell that apart
// from a real brand, so it was persisted onto the item AND projected into the
// eBay item specifics, and the seller had to delete the literal string
// "<UNKNOWN>" out of BOTH places before typing the real value. These tests pin
// the guard that drops it.
//
// The counter-case matters just as much: a real value that merely CONTAINS one
// of these words ("Unknown Pleasures" the album tee, "No Boundaries" the actual
// Walmart brand) must survive untouched.
//
// Pure functions — no Anthropic/Supabase calls — but ai-extract.ts transitively
// imports the service-role client at load, so set dummy env BEFORE the import.
//   deno test --allow-env src/tests/ai-placeholder-values_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { decodeExtraction, isPlaceholderValue } = await import("../lib/ai-extract.ts");

Deno.test("isPlaceholderValue catches the forms the model actually emits", () => {
  // The exact string seen in production edge logs.
  assert(isPlaceholderValue("<UNKNOWN>"));
  for (
    const v of [
      "unknown",
      "UNKNOWN",
      " Unknown ",
      "[unknown]",
      "(N/A)",
      "n/a",
      "NA",
      "none",
      "null",
      "-",
      "?",
      "TBD",
      "not visible",
      "Not Specified",
      "unbranded",
      "No Brand",
      "illegible",
      "",
      "   ",
      null,
      undefined,
    ]
  ) {
    assert(isPlaceholderValue(v), `expected placeholder: ${JSON.stringify(v)}`);
  }
});

Deno.test("isPlaceholderValue leaves real values alone", () => {
  for (
    const v of [
      "Nike",
      "Unknown Pleasures", // Joy Division tee — a real style name
      "No Boundaries", // a real Walmart brand
      "None of the Above", // a real graphic-tee slogan
      "Nailed It", // starts with "n/a" letters, not the token
      "M",
      "XL",
      "10.5",
      "Naturalizer", // starts with "na"
    ]
  ) {
    assertEquals(
      isPlaceholderValue(v),
      false,
      `expected real value: ${JSON.stringify(v)}`,
    );
  }
});

Deno.test("decodeExtraction drops a placeholder brand instead of suggesting it", () => {
  const res = decodeExtraction(
    {
      title: { value: "Women's Black Stretch Ponte Leggings", confidence: 0.8 },
      // Exactly what production returned: a placeholder at confidence 0.
      brand: { value: "<UNKNOWN>", confidence: 0, source: "photo" },
      size: { value: "N/A", confidence: 0.2, source: "photo:tag" },
      color: { value: "Black", confidence: 0.9 },
    },
    true,
  );
  // The two placeholders are gone entirely — not present-but-empty, ABSENT, so
  // every downstream gap-fill treats the field as unfilled.
  assertEquals(res.suggestions.brand, undefined);
  assertEquals(res.suggestions.size, undefined);
  assert(!("brand" in res.suggestions));
  assert(!("size" in res.suggestions));
  // Real fields in the same payload are untouched.
  assertEquals(res.suggestions.color.value, "Black");
  assertEquals(res.suggestions.title.value, "Women's Black Stretch Ponte Leggings");
});

Deno.test("decodeExtraction drops placeholder canonical attributes", () => {
  const res = decodeExtraction(
    {
      attributes: {
        department: { value: "Women", confidence: 0.9 },
        pattern: { value: "<UNKNOWN>", confidence: 0 },
        sleeve_length: { values: ["unknown", "Short Sleeve"], confidence: 0.7 },
      },
    },
    true,
  );
  assertEquals(res.attributes.department?.values, ["Women"]);
  assertEquals(res.attributes.pattern, undefined);
  // A placeholder mixed INTO a real list drops only the placeholder.
  assertEquals(res.attributes.sleeve_length?.values, ["Short Sleeve"]);
});

Deno.test("decodeExtraction drops a research block whose style is a placeholder", () => {
  const res = decodeExtraction(
    {
      research_identification: {
        identified_style: "<UNKNOWN>",
        identification_rationale: "Could not identify the product.",
        identification_confidence: 0.9,
      },
    },
    true,
  );
  // No style name means no usable identification — and critically, no
  // "<UNKNOWN>" leaking into the style suggestion via the research fallback.
  assertEquals(res.research, null);
  assertEquals(res.suggestions.style, undefined);
});
