// US-1527: research-tier product identification. Pure decode-fixture eval —
// each fixture is a plausible extract_item_fields tool output for a KNOWN item
// (the transcripts the model should produce for common Lululemon / Nike /
// Patagonia / Levi's styles), asserting the schema decode, the confidence
// floor, the required-rationale rule, and the style-suggestion injection with
// research provenance. No AI/DB calls.
import { assert, assertEquals } from "@std/assert";

// ai-extract.ts transitively imports the service-role supabase client at load,
// so set dummy env BEFORE the dynamic import (standard test pattern).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { decodeExtraction, RESEARCH_MIN_CONFIDENCE, RESEARCH_SOURCE } = await import(
  "../lib/ai-extract.ts"
);

// One known-item fixture: the raw research_identification block the model is
// expected to emit, plus what the decoded result must contain.
interface KnownItemFixture {
  name: string;
  raw: Record<string, unknown>;
  expectStyle: string;
  expectLine: string | null;
  expectFabric: string | null;
  expectMsrpCents: number | null;
}

const KNOWN_ITEMS: KnownItemFixture[] = [
  {
    name: "Lululemon ABC Pant Classic (Warpstreme)",
    raw: {
      identified_style: "ABC Pant Classic",
      product_line: "ABC",
      fabric_technology: "Warpstreme",
      msrp_estimate_cents: 12800,
      identification_rationale:
        "Gusseted crotch + zippered back pocket visible in the back photo; Warpstreme on the care label; Lululemon wordmark on the waistband tag",
      identification_confidence: 0.85,
    },
    expectStyle: "ABC Pant Classic",
    expectLine: "ABC",
    expectFabric: "Warpstreme",
    expectMsrpCents: 12800,
  },
  {
    name: "Lululemon Commission Pant (dress waistband)",
    raw: {
      identified_style: "Commission Pant Classic",
      product_line: "Commission",
      fabric_technology: "Warpstreme",
      msrp_estimate_cents: 12800,
      identification_rationale:
        "Dress-pant waistband with hook closure and hidden zip back pockets in the detail photo; crease-front legs in the front photo",
      identification_confidence: 0.72,
    },
    expectStyle: "Commission Pant Classic",
    expectLine: "Commission",
    expectFabric: "Warpstreme",
    expectMsrpCents: 12800,
  },
  {
    name: "Lululemon Align High-Rise Legging",
    raw: {
      identified_style: "Align High-Rise Pant 25\"",
      product_line: "Align",
      fabric_technology: "Nulu",
      msrp_estimate_cents: 9800,
      identification_rationale:
        "Buttery matte fabric with no front seam in the front photo; waistband pocket layout; rip tag size dot format",
      identification_confidence: 0.78,
    },
    expectStyle: "Align High-Rise Pant 25\"",
    expectLine: "Align",
    expectFabric: "Nulu",
    expectMsrpCents: 9800,
  },
  {
    name: "Lululemon Scuba Oversized Half-Zip",
    raw: {
      identified_style: "Scuba Oversized Funnel-Neck Half Zip",
      product_line: "Scuba",
      fabric_technology: "Cotton-blend fleece",
      msrp_estimate_cents: 11800,
      identification_rationale:
        "Funnel neck + kangaroo pocket + oversized crop in the front photo; thumbholes in the sleeve detail",
      identification_confidence: 0.8,
    },
    expectStyle: "Scuba Oversized Funnel-Neck Half Zip",
    expectLine: "Scuba",
    expectFabric: "Cotton-blend fleece",
    expectMsrpCents: 11800,
  },
  {
    name: "Nike Tech Fleece Jogger",
    raw: {
      identified_style: "Sportswear Tech Fleece Jogger",
      product_line: "Tech Fleece",
      fabric_technology: "Tech Fleece",
      msrp_estimate_cents: 11000,
      identification_rationale:
        "Signature paneled double-faced fleece seams in the front/back photos; tapered ankle zips in the detail photo; CU4495 style code on the tag",
      identification_confidence: 0.88,
    },
    expectStyle: "Sportswear Tech Fleece Jogger",
    expectLine: "Tech Fleece",
    expectFabric: "Tech Fleece",
    expectMsrpCents: 11000,
  },
  {
    name: "Nike Dri-FIT Miler running tee",
    raw: {
      identified_style: "Dri-FIT Miler",
      product_line: "Dri-FIT",
      fabric_technology: "Dri-FIT",
      msrp_estimate_cents: 3000,
      identification_rationale:
        "Reflective swoosh at chest + drop-tail hem in the front photo; Dri-FIT woven label in the tag photo",
      identification_confidence: 0.66,
    },
    expectStyle: "Dri-FIT Miler",
    expectLine: "Dri-FIT",
    expectFabric: "Dri-FIT",
    expectMsrpCents: 3000,
  },
  {
    name: "Patagonia Better Sweater 1/4-Zip",
    raw: {
      identified_style: "Better Sweater 1/4-Zip",
      product_line: "Better Sweater",
      fabric_technology: "Recycled polyester sweater-knit fleece",
      msrp_estimate_cents: 12900,
      identification_rationale:
        "Sweater-knit face with fleece interior visible at the collar in the detail photo; contrast zipper garage; 25523 style code on the care label",
      identification_confidence: 0.9,
    },
    expectStyle: "Better Sweater 1/4-Zip",
    expectLine: "Better Sweater",
    expectFabric: "Recycled polyester sweater-knit fleece",
    expectMsrpCents: 12900,
  },
  {
    name: "Patagonia Nano Puff Jacket",
    raw: {
      identified_style: "Nano Puff Jacket",
      product_line: "Nano Puff",
      fabric_technology: "PrimaLoft Gold Eco",
      msrp_estimate_cents: 23900,
      identification_rationale:
        "Signature horizontal brick quilting in the front photo; interior chest-pocket stuff sack in the interior photo",
      identification_confidence: 0.87,
    },
    expectStyle: "Nano Puff Jacket",
    expectLine: "Nano Puff",
    expectFabric: "PrimaLoft Gold Eco",
    expectMsrpCents: 23900,
  },
  {
    name: "Patagonia Baggies 5\"",
    raw: {
      identified_style: "Baggies Shorts 5\"",
      product_line: "Baggies",
      fabric_technology: "NetPlus recycled nylon",
      msrp_estimate_cents: 6500,
      identification_rationale:
        "Elastic drawstring waist + mesh pocket bags visible in the detail photo; classic Baggies silhouette in the flat lay",
      identification_confidence: 0.75,
    },
    expectStyle: "Baggies Shorts 5\"",
    expectLine: "Baggies",
    expectFabric: "NetPlus recycled nylon",
    expectMsrpCents: 6500,
  },
  {
    name: "Levi's 501 Original Fit",
    raw: {
      identified_style: "501 Original Fit",
      product_line: "501",
      fabric_technology: null, // model may omit — decodes to null
      msrp_estimate_cents: 6950,
      identification_rationale:
        "Button fly in the front photo; arcuate stitching + red tab in the back-pocket detail; 501 on the patch",
      identification_confidence: 0.93,
    },
    expectStyle: "501 Original Fit",
    expectLine: "501",
    expectFabric: null,
    expectMsrpCents: 6950,
  },
  {
    name: "Carhartt Detroit Jacket (line only, no fabric/msrp)",
    raw: {
      identified_style: "Detroit Jacket",
      product_line: "Detroit",
      identification_rationale:
        "Blanket-lined duck canvas visible at the collar; corduroy collar + brass zip in the detail photo",
      identification_confidence: 0.7,
    },
    expectStyle: "Detroit Jacket",
    expectLine: "Detroit",
    expectFabric: null,
    expectMsrpCents: null,
  },
];

Deno.test("US-1527 eval: known-item fixtures decode with full research payloads", () => {
  assert(KNOWN_ITEMS.length >= 10, "eval set must hold at least 10 known items");
  for (const fx of KNOWN_ITEMS) {
    const res = decodeExtraction({ research_identification: fx.raw }, true);
    assert(res.research, `${fx.name}: research block must survive decode`);
    assertEquals(res.research!.identifiedStyle, fx.expectStyle, fx.name);
    assertEquals(res.research!.productLine, fx.expectLine, fx.name);
    assertEquals(res.research!.fabricTechnology, fx.expectFabric, fx.name);
    assertEquals(res.research!.msrpEstimateCents, fx.expectMsrpCents, fx.name);
    assert(
      (res.research!.rationale ?? "").length > 0,
      `${fx.name}: rationale must survive`,
    );
    assert(
      res.research!.confidence >= RESEARCH_MIN_CONFIDENCE,
      `${fx.name}: confidence intact`,
    );
    // The identification also fills the style suggestion with research provenance.
    assertEquals(res.suggestions.style?.value, fx.expectStyle, fx.name);
    assertEquals(res.suggestions.style?.source, RESEARCH_SOURCE, fx.name);
  }
});

Deno.test("US-1527: identifications below the confidence floor are dropped whole", () => {
  const res = decodeExtraction(
    {
      research_identification: {
        identified_style: "ABC Pant Classic",
        product_line: "ABC",
        identification_rationale: "Looks like joggers",
        identification_confidence: 0.49, // just under the floor
      },
    },
    true,
  );
  assertEquals(res.research, null);
  // …and no research-sourced style suggestion appears either.
  assertEquals(res.suggestions.style, undefined);
});

Deno.test("US-1527: a missing rationale kills the identification (unverifiable ID)", () => {
  const res = decodeExtraction(
    {
      research_identification: {
        identified_style: "Nano Puff Jacket",
        identification_confidence: 0.9,
      },
    },
    true,
  );
  assertEquals(res.research, null);
});

Deno.test("US-1527: an OBSERVED style always wins over the research style", () => {
  const res = decodeExtraction(
    {
      style: { value: "Better Sweater", confidence: 0.95, source: "photo:tag" },
      research_identification: {
        identified_style: "Better Sweater 1/4-Zip",
        identification_rationale: "Sweater-knit face, contrast zip garage",
        identification_confidence: 0.9,
      },
    },
    true,
  );
  // Style keeps its observed value + provenance; research still returned.
  assertEquals(res.suggestions.style?.value, "Better Sweater");
  assertEquals(res.suggestions.style?.source, "photo:tag");
  assertEquals(res.research?.identifiedStyle, "Better Sweater 1/4-Zip");
});

Deno.test("US-1527: msrp outside the sanity band decodes to null, not garbage", () => {
  for (const bad of [12.8 /* dollars, not cents */, 0, -500, 99_999_999, "not-a-number"]) {
    const res = decodeExtraction(
      {
        research_identification: {
          identified_style: "ABC Pant Classic",
          identification_rationale: "Gusset + zip pocket",
          identification_confidence: 0.8,
          msrp_estimate_cents: bad,
        },
      },
      true,
    );
    assert(res.research, `research survives msrp=${bad}`);
    assertEquals(res.research!.msrpEstimateCents, null, `msrp=${bad} → null`);
  }
});

Deno.test("US-1527: absent research block decodes to null without side effects", () => {
  const res = decodeExtraction(
    { brand: { value: "Lululemon", confidence: 0.9, source: "photo:tag" } },
    true,
  );
  assertEquals(res.research, null);
  assertEquals(res.suggestions.style, undefined);
});
