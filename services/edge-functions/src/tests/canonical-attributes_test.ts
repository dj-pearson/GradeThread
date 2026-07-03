// US-821: canonical attribute capture. Covers the pure decode of the single
// extract tool's output (`decodeExtraction`) — both the canonical `attributes`
// object AND a regression on the original 9 core fields — plus the persistence
// mapping to the inventory_items.attributes column form (`attributesToColumn`).
// All pure functions — no Anthropic/Supabase calls — but ai-extract.ts
// transitively imports the service-role client at load, so set dummy env
// BEFORE the dynamic import (standard test pattern; the old static import only
// passed when an earlier suite file had set the env first).
//   deno test --allow-env src/tests/canonical-attributes_test.ts
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { attributesToColumn, CANONICAL_ATTRIBUTES, decodeExtraction } = await import(
  "../lib/ai-extract.ts"
);
type AttributeSuggestion = import("../lib/ai-extract.ts").AttributeSuggestion;

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

// ── US-1526: tag identity codes (style_code / rn_number / upc) ───────────────

Deno.test("US-1526: the three code attributes are registered single-value specs", () => {
  const keys = CANONICAL_ATTRIBUTES.map((a) => a.key);
  for (const k of ["style_code", "rn_number", "upc"]) {
    assertEquals(keys.includes(k), true, `${k} missing from CANONICAL_ATTRIBUTES`);
  }
  for (const spec of CANONICAL_ATTRIBUTES) {
    if (["style_code", "rn_number", "upc"].includes(spec.key)) {
      assertEquals(spec.multi, false, `${spec.key} must be single-value`);
    }
  }
});

Deno.test("US-1526: codes decode verbatim with their (low) confidence preserved", () => {
  const res = decodeExtraction(
    {
      attributes: {
        style_code: { value: "LW7DVCS", confidence: 0.9, source: "photo:tag" },
        // Garbled partial read — the prompt asks for low confidence, not omission.
        rn_number: { value: "1062?9", confidence: 0.3, source: "photo:tag" },
        upc: { value: "0090563238941", confidence: 0.35, source: "photo:tag" },
      },
    },
    true,
  );
  assertEquals(res.attributes.style_code.values, ["LW7DVCS"]);
  assertEquals(res.attributes.style_code.confidence, 0.9);
  assertEquals(res.attributes.rn_number.values, ["1062?9"]); // verbatim, not normalized
  assertEquals(res.attributes.rn_number.confidence, 0.3);
  // Leading zero preserved verbatim (never reformat digits).
  assertEquals(res.attributes.upc.values, ["0090563238941"]);
});

Deno.test("US-1526: absent codes stay absent (no phantom keys)", () => {
  const res = decodeExtraction(
    { attributes: { department: { value: "Men", confidence: 0.9 } } },
    true,
  );
  assertEquals(res.attributes.style_code, undefined);
  assertEquals(res.attributes.rn_number, undefined);
  assertEquals(res.attributes.upc, undefined);
  // …and persistence maps whatever IS present without inventing codes.
  const col = attributesToColumn(res.attributes);
  assertEquals(col.style_code, undefined);
  assertEquals(col.department, "Men");
});

Deno.test("US-1526: a code attribute persists to the attributes column as a scalar", () => {
  const attributes: Record<string, AttributeSuggestion> = {
    style_code: { values: ["CV8839-010"], confidence: 0.8, source: "photo:tag" },
    upc: { values: ["885176939001"], confidence: 0.4, source: "photo:tag" },
  };
  const col = attributesToColumn(attributes);
  assertEquals(col.style_code, "CV8839-010");
  assertEquals(col.upc, "885176939001");
});

// ── US-1530: conflicts[] decode (cross-photo disagreements surface, never coin-flip) ──

Deno.test("US-1530: decodeExtraction parses conflicts and drops malformed entries", () => {
  const res = decodeExtraction(
    {
      size: { value: "M", confidence: 0.6, source: "photo:tag" },
      conflicts: [
        { field: "size", text_value: "M", photo_value: "8 (waistband print)" },
        { field: "brand", text_value: "Lululemon", photo_value: "Lulu Lemon" },
        { text_value: "no-field", photo_value: "dropped" }, // malformed → dropped
        "garbage",
      ],
    },
    true,
  );
  assertEquals(res.conflicts.length, 2);
  assertEquals(res.conflicts[0], {
    field: "size",
    text_value: "M",
    photo_value: "8 (waistband print)",
  });
  assertEquals(res.conflicts[1].field, "brand");
});

Deno.test("US-1530: absent conflicts decode to an empty array", () => {
  const res = decodeExtraction({}, true);
  assertEquals(res.conflicts, []);
});
