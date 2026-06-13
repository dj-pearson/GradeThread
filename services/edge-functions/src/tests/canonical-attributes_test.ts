// US-821: canonical attribute capture. Covers the pure decode of the single
// extract tool's output (`decodeExtraction`) — both the canonical `attributes`
// object AND a regression on the original 9 core fields — plus the persistence
// mapping to the inventory_items.attributes column form (`attributesToColumn`).
// All pure functions — no Anthropic/Supabase — so no env setup is needed.
//   deno test src/tests/canonical-attributes_test.ts
import { assertEquals } from "@std/assert";
import {
  attributesToColumn,
  CANONICAL_ATTRIBUTES,
  decodeExtraction,
  type AttributeSuggestion,
} from "../lib/ai-extract.ts";

// ── decodeExtraction: original 9 core fields regression ─────────────────────

Deno.test("decodeExtraction decodes the original core fields unchanged", () => {
  const res = decodeExtraction(
    {
      title: { value: " Vintage Levi's Trucker Jacket ", confidence: 0.9, source: "photo:front" },
      brand: { value: "Levi's", confidence: 0.95, source: "photo:tag" },
      size: { value: "M", confidence: 0.8 },
      color: { value: "", confidence: 0.4 }, // empty value -> dropped
    },
    true,
  );
  // Trimmed value, explicit source preserved.
  assertEquals(res.suggestions.title.value, "Vintage Levi's Trucker Jacket");
  assertEquals(res.suggestions.title.source, "photo:front");
  assertEquals(res.suggestions.brand.confidence, 0.95);
  // Missing source falls back to the photo/text default.
  assertEquals(res.suggestions.size.source, "photo");
  // Empty-valued field is omitted.
  assertEquals(res.suggestions.color, undefined);
  // No attributes object present -> empty map, not a throw.
  assertEquals(res.attributes, {});
});

Deno.test("decodeExtraction clamps confidence and defaults source to text when no photos", () => {
  const res = decodeExtraction(
    {
      brand: { value: "Nike", confidence: 5, source: "" }, // >1 clamps to 1
      size: { value: "L", confidence: "not-a-number" }, // NaN -> 0.5
    },
    false,
  );
  assertEquals(res.suggestions.brand.confidence, 1);
  assertEquals(res.suggestions.brand.source, "text");
  assertEquals(res.suggestions.size.confidence, 0.5);
});

// ── decodeExtraction: canonical attributes (US-821) ─────────────────────────

Deno.test("decodeExtraction captures single + multi canonical attributes", () => {
  const res = decodeExtraction(
    {
      attributes: {
        department: { value: "Men", confidence: 0.9, source: "photo:tag" },
        features: { values: ["Pockets", "Hooded"], confidence: 0.7, source: "photo:front" },
      },
    },
    true,
  );
  assertEquals(res.attributes.department, {
    values: ["Men"],
    confidence: 0.9,
    source: "photo:tag",
  });
  assertEquals(res.attributes.features.values, ["Pockets", "Hooded"]);
});

Deno.test("decodeExtraction truncates a single attribute to one value and drops empties/unknown", () => {
  const res = decodeExtraction(
    {
      attributes: {
        // single attr handed an array -> first value only
        fit: { values: ["Slim", "Relaxed"], confidence: 0.6 },
        // "unknown" and blanks are dropped, leaving nothing -> attr omitted
        neckline: { value: "unknown", confidence: 0.5 },
        pattern: { value: "  ", confidence: 0.5 },
        // multi attr with mixed valid/blank/unknown
        features: { values: ["Lined", "", "unknown", "Stretch"], confidence: 0.5 },
      },
    },
    true,
  );
  assertEquals(res.attributes.fit.values, ["Slim"]);
  assertEquals(res.attributes.neckline, undefined);
  assertEquals(res.attributes.pattern, undefined);
  assertEquals(res.attributes.features.values, ["Lined", "Stretch"]);
});

Deno.test("decodeExtraction defaults attribute confidence/source like core fields", () => {
  const res = decodeExtraction(
    {
      attributes: {
        vintage: { value: "Yes", confidence: 9 }, // clamps to 1, no source -> default
      },
    },
    false,
  );
  assertEquals(res.attributes.vintage.confidence, 1);
  assertEquals(res.attributes.vintage.source, "text");
});

Deno.test("CANONICAL_ATTRIBUTES has exactly one multi attribute (features)", () => {
  const multi = CANONICAL_ATTRIBUTES.filter((a) => a.multi).map((a) => a.key);
  assertEquals(multi, ["features"]);
});

// ── attributesToColumn: persistence mapping ─────────────────────────────────

Deno.test("attributesToColumn maps single attrs to scalars and multi to arrays", () => {
  const attributes: Record<string, AttributeSuggestion> = {
    department: { values: ["Women"], confidence: 0.9, source: "photo:tag" },
    features: { values: ["Pockets", "Stretch"], confidence: 0.7, source: "photo:front" },
  };
  const col = attributesToColumn(attributes);
  assertEquals(col.department, "Women"); // scalar string
  assertEquals(col.features, ["Pockets", "Stretch"]); // string[]
});

Deno.test("attributesToColumn skips attributes with no values", () => {
  const attributes: Record<string, AttributeSuggestion> = {
    department: { values: [], confidence: 0.9, source: "text" },
    fit: { values: ["Slim"], confidence: 0.6, source: "text" },
  };
  const col = attributesToColumn(attributes);
  assertEquals(col.department, undefined);
  assertEquals(col.fit, "Slim");
});
