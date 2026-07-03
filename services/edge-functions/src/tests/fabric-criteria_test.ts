// US-1534: fabric-aware grading criteria — class mapping, elastane modifier,
// parse hardening, and the strictly-additive composite guarantee.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  dominantFiberClass,
  fabricCriteriaBlock,
  hasElastane,
  normalizeFiberContent,
} = await import("../lib/fabric-criteria.ts");
const { buildCompositeUserPrompt } = await import("../lib/ai-grading.ts");

Deno.test("US-1534: dominant class picks the highest-percentage matching fiber", () => {
  assertEquals(
    dominantFiberClass([{ fiber: "cashmere", pct: 100 }]),
    "wool_cashmere",
  );
  assertEquals(
    dominantFiberClass([
      { fiber: "cotton", pct: 98 },
      { fiber: "elastane", pct: 2 },
    ]),
    "cotton_denim",
  );
  assertEquals(
    dominantFiberClass([
      { fiber: "Polyester", pct: 60 },
      { fiber: "wool", pct: 40 },
    ]),
    "synthetic",
  );
  assertEquals(dominantFiberClass([{ fiber: "silk", pct: null }]), "silk");
  assertEquals(dominantFiberClass([{ fiber: "suede", pct: null }]), "leather_suede");
  assertEquals(dominantFiberClass([{ fiber: "linen", pct: 55 }, { fiber: "cotton", pct: 45 }]), "linen");
  // Unknown fibers / empty → null (no criteria injected).
  assertEquals(dominantFiberClass([{ fiber: "unobtainium", pct: 100 }]), null);
  assertEquals(dominantFiberClass([]), null);
  // Elastane alone never becomes the class — it is a modifier.
  assertEquals(dominantFiberClass([{ fiber: "spandex", pct: 100 }]), null);
});

Deno.test("US-1534: percent-less labels resolve by listing order", () => {
  // "Cotton, Elastane" with no percentages: cotton listed first wins.
  assertEquals(
    dominantFiberClass([
      { fiber: "cotton", pct: null },
      { fiber: "polyester", pct: null },
    ]),
    "cotton_denim",
  );
});

Deno.test("US-1534: elastane modifier detected across synonyms", () => {
  assert(hasElastane([{ fiber: "Elastane", pct: 7 }]));
  assert(hasElastane([{ fiber: "SPANDEX", pct: 5 }]));
  assert(hasElastane([{ fiber: "lycra", pct: null }]));
  assert(!hasElastane([{ fiber: "cotton", pct: 100 }]));
});

Deno.test("US-1534: normalizeFiberContent omits garbage, clamps pct, caps entries", () => {
  assertEquals(normalizeFiberContent(undefined), []);
  assertEquals(normalizeFiberContent("93% nylon"), []);
  assertEquals(
    normalizeFiberContent([
      { fiber: "nylon", pct: 93 },
      { fiber: "elastane", pct: "7" }, // numeric string coerces
      { fiber: "", pct: 50 }, // empty fiber dropped
      { pct: 10 }, // missing fiber dropped
      { fiber: "wool", pct: 250 }, // clamped to 100
      { fiber: "silk", pct: "??" }, // unreadable pct → null
    ]),
    [
      { fiber: "nylon", pct: 93 },
      { fiber: "elastane", pct: 7 },
      { fiber: "wool", pct: 100 },
      { fiber: "silk", pct: null },
    ],
  );
  const many = normalizeFiberContent(
    Array.from({ length: 20 }, (_, i) => ({ fiber: `f${i}`, pct: 5 })),
  );
  assertEquals(many.length, 8);
});

Deno.test("US-1534: fabricCriteriaBlock reads the label images and renders both blocks", () => {
  const block = fabricCriteriaBlock([
    { image_type: "front" },
    {
      image_type: "label",
      fiber_content: [
        { fiber: "cashmere", pct: 95 },
        { fiber: "elastane", pct: 5 },
      ],
    },
  ]);
  assert(block.includes("FABRIC-SPECIFIC CRITERIA"));
  assert(block.includes("95% cashmere, 5% elastane"));
  assert(block.includes("comb"), "cashmere criteria present");
  assert(block.includes("RECOVERY"), "elastane modifier present");
  // Cashmere pilling weighted differently than tech-fleece pilling: the
  // synthetic block escalates, the wool block forgives.
  const fleece = fabricCriteriaBlock([
    { image_type: "label", fiber_content: [{ fiber: "polyester", pct: 100 }] },
  ]);
  assert(fleece.includes("HEAVY wear"));
});

Deno.test("US-1534: no fiber read → empty block; label_2 fallback works", () => {
  assertEquals(fabricCriteriaBlock([{ image_type: "front" }]), "");
  assertEquals(
    fabricCriteriaBlock([{ image_type: "label", fiber_content: [] }]),
    "",
  );
  const viaSecond = fabricCriteriaBlock([
    { image_type: "label", fiber_content: [] },
    { image_type: "label_2", fiber_content: [{ fiber: "denim", pct: null }] },
  ]);
  assert(viaSecond.includes("whiskering"));
});

Deno.test("US-1534 REGRESSION: composite prompt byte-identical without a fabric block", () => {
  const garmentInfo = {
    garment_type: "tops",
    garment_category: "sweater",
    brand: "Patagonia",
    title: "Better Sweater",
    description: null,
  };
  const before = buildCompositeUserPrompt([], garmentInfo, "");
  const withEmpty = buildCompositeUserPrompt([], garmentInfo, "", "");
  assertEquals(before, withEmpty);

  const fabric = fabricCriteriaBlock([
    { image_type: "label", fiber_content: [{ fiber: "wool", pct: 100 }] },
  ]);
  const withFabric = buildCompositeUserPrompt([], garmentInfo, "", fabric);
  assert(withFabric.includes("FABRIC-SPECIFIC CRITERIA"));
  assert(
    withFabric.indexOf("FABRIC-SPECIFIC CRITERIA") <
      withFabric.indexOf("GARMENT INFO"),
  );
});
