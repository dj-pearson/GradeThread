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

// ── US-3307 AC4: "Unbranded" is an ANSWER, "Unknown" is not ─────────────────
//
// eBay ships Unbranded and Handmade as real Brand aspect values for a garment
// that carries no maker's label. Before this, both were in PLACEHOLDER_VALUES
// and were dropped exactly like "<UNKNOWN>", so an item the model had correctly
// read as label-less came back indistinguishable from one whose tag it could not
// find — and the publish path then defaulted the empty column to the literal
// string "Unbranded" anyway (flipdesk-ebay.ts), turning "we do not know" into a
// public claim that the garment has no maker.
//
// The check is FIELD-SCOPED: unchanged for every other field, and "no brand"
// stays a placeholder because it is what the sell-through RPC coalesces an empty
// brand to rather than something a seller types.

Deno.test("US-3307: Unbranded and Handmade survive on the brand field", () => {
  for (const v of ["Unbranded", "unbranded", "UNBRANDED", " Handmade "]) {
    assertEquals(
      isPlaceholderValue(v, "brand"),
      false,
      `expected a real brand answer: ${JSON.stringify(v)}`,
    );
    // Same value on the eBay aspect, which is where the refine pass sees it.
    assertEquals(isPlaceholderValue(v, "Brand"), false);
  }
});

Deno.test("US-3307: they stay placeholders everywhere else", () => {
  for (const field of [undefined, "color", "material", "style", "Pattern"]) {
    assert(
      isPlaceholderValue("unbranded", field),
      `expected placeholder on field ${String(field)}`,
    );
  }
});

Deno.test("US-3307: 'we do not know' is still dropped on the brand field", () => {
  for (const v of ["<UNKNOWN>", "unknown", "n/a", "no brand", "not visible", "illegible"]) {
    assert(
      isPlaceholderValue(v, "brand"),
      `expected placeholder on brand: ${JSON.stringify(v)}`,
    );
  }
});

Deno.test("US-3307: decodeExtraction keeps a deliberate Unbranded brand", () => {
  const res = decodeExtraction(
    {
      brand: { value: "Unbranded", confidence: 0.85, source: "photo:tag" },
      color: { value: "unbranded", confidence: 0.4 },
    },
    true,
  );
  assertEquals(res.suggestions.brand?.value, "Unbranded");
  assertEquals(res.suggestions.brand?.confidence, 0.85);
  // The same string on a field where it means nothing is still dropped.
  assertEquals(res.suggestions.color, undefined);
});
