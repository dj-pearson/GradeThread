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

// The multi set is small and deliberate: an attribute is multi ONLY when eBay's
// matching aspect is genuinely multi-select. Everything else is single so
// attributesToColumn writes a scalar and the composer renders one row.
Deno.test("CANONICAL_ATTRIBUTES multi attributes are exactly features, accents and observations", () => {
  const multi = CANONICAL_ATTRIBUTES.filter((a) => a.multi).map((a) => a.key);
  assertEquals(multi.sort(), ["accents", "features", "observations"]);
});

Deno.test("CANONICAL_ATTRIBUTES keys are unique", () => {
  const keys = CANONICAL_ATTRIBUTES.map((a) => a.key);
  assertEquals(new Set(keys).size, keys.length);
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

// ── US-2421: the wide capture (40 keys + the observations catch-all) ─────────

// The keys the story names explicitly. Listed literally rather than derived, so
// dropping one from CANONICAL_ATTRIBUTES fails here instead of silently
// shrinking what a single capture pass can hold.
const US_2421_KEYS = [
  "accents", "product_line", "fabric_weight", "fabric_type", "occasion",
  "activity", "lining", "heel_type", "heel_height", "toe_shape", "strap_type",
  "sleeve_style", "rise", "leg_style", "character", "collaboration", "season",
  "era",
  // Added alongside them to cover the same four verticals end to end.
  "model", "shoe_width", "shoe_shaft_height", "hardware_color",
  "dress_length", "garment_length",
];

Deno.test("US-2421: every widened key is a registered canonical attribute", () => {
  const keys = new Set(CANONICAL_ATTRIBUTES.map((a) => a.key));
  for (const k of US_2421_KEYS) {
    assertEquals(keys.has(k), true, `${k} missing from CANONICAL_ATTRIBUTES`);
  }
});

Deno.test("US-2421: the capture holds 41 named attributes plus the catch-all", () => {
  // 40 -> 41 on 2026-08-23: US-2796 added `shoe_size_scale`. The number is not
  // the point of this case - the TRUNCATION CANARY below is, and it is why the
  // count is pinned at all. Every added slot widens the tool-call JSON, and
  // max_tokens was already raised to 4096 when this went from 16 to 40 to stop
  // it truncating mid-string. Bump this deliberately, after checking the canary
  // still passes, rather than to make a red test green.
  const named = CANONICAL_ATTRIBUTES.filter((a) => a.key !== "observations");
  assertEquals(named.length, 41);
  assertEquals(
    CANONICAL_ATTRIBUTES.some((a) => a.key === "observations" && a.multi),
    true,
    "observations must be a multi-valued catch-all",
  );
});

// Build a raw tool-call payload that fills EVERY canonical slot, the way a
// maximally-informative photo set would. This is the truncation canary: if the
// wider schema ever outgrows the decode path, this loses keys.
function fullFillRaw(): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const spec of CANONICAL_ATTRIBUTES) {
    attributes[spec.key] = spec.multi
      ? { values: [`${spec.key}-a`, `${spec.key}-b`], confidence: 0.8, source: "photo:front" }
      : { value: `${spec.key}-value`, confidence: 0.8, source: "photo:tag" };
  }
  return { attributes };
}

Deno.test("US-2421: a full-fill response decodes without loss", () => {
  const res = decodeExtraction(fullFillRaw(), true);
  assertEquals(
    Object.keys(res.attributes).sort(),
    CANONICAL_ATTRIBUTES.map((a) => a.key).sort(),
  );
  for (const spec of CANONICAL_ATTRIBUTES) {
    const got = res.attributes[spec.key];
    assertEquals(got.confidence, 0.8, `${spec.key} confidence lost`);
    assertEquals(
      got.values,
      spec.multi ? [`${spec.key}-a`, `${spec.key}-b`] : [`${spec.key}-value`],
      `${spec.key} values lost`,
    );
  }
});

Deno.test("US-2421: a full-fill response persists every key to the attributes column", () => {
  const res = decodeExtraction(fullFillRaw(), true);
  const col = attributesToColumn(res.attributes);
  for (const spec of CANONICAL_ATTRIBUTES) {
    if (spec.multi) {
      assertEquals(col[spec.key], [`${spec.key}-a`, `${spec.key}-b`]);
    } else {
      assertEquals(col[spec.key], `${spec.key}-value`);
    }
  }
});

Deno.test("US-2421: observations captures unnamed facts as an array; absent stays absent", () => {
  const res = decodeExtraction(
    {
      attributes: {
        observations: {
          values: ["pocket style: patch pockets", "cuff: ribbed", "  ", "unknown"],
          confidence: 0.6,
          source: "photo:detail",
        },
      },
    },
    true,
  );
  // Blank + placeholder entries are dropped; the real facts survive verbatim.
  assertEquals(res.attributes.observations.values, [
    "pocket style: patch pockets",
    "cuff: ribbed",
  ]);
  // …and it persists as an array, so a future canonical key can be backfilled
  // from stored data instead of a fresh AI pass (AC2).
  assertEquals(attributesToColumn(res.attributes).observations, [
    "pocket style: patch pockets",
    "cuff: ribbed",
  ]);
  assertEquals(decodeExtraction({}, true).attributes.observations, undefined);
});

Deno.test("US-2421: the new single-valued keys truncate an array to one value", () => {
  const res = decodeExtraction(
    {
      attributes: {
        heel_type: { values: ["Block", "Wedge"], confidence: 0.7 },
        accents: { values: ["Embroidered", "Beaded"], confidence: 0.7 },
      },
    },
    true,
  );
  assertEquals(res.attributes.heel_type.values, ["Block"]);
  // accents is genuinely multi-select on eBay, so both survive.
  assertEquals(res.attributes.accents.values, ["Embroidered", "Beaded"]);
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
