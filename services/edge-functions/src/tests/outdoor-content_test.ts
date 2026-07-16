// US-1734: verify the outdoor & technical content (migration 00453) is correct +
// consumable by the engine. This group's through-line is that identity is the
// FABRIC TECHNOLOGY and it is PRINTED on the garment — so the prompt block has to
// carry the fingerprint that separates the tech siblings (Columbia's two
// Interchange parkas, Arc'teryx's Atom-vs-Cerium fill, Marmot's MemBrain-vs-
// Gore-Tex shells). Arc'teryx is the only brand here with a regular garment-
// printed code, so it is the only one whose block should carry the transcribe-the-
// code hint — the resolver-side decode itself is covered by brand-knowledge-golden.
//
// The size leg carries this group's signature trap, which runs OPPOSITE to
// activewear: an outdoor shell is cut with layering room, so its flat chest
// measures ABOVE the body chest it is sized to (a compression legging measures
// below). Plus L.L.Bean's generous cut. Both are asserted reachable.
//
// brand-knowledge.ts + sizing-charts.ts import supabase at load → dummy env first.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { brandPackPromptBlock } = await import("../lib/brand-knowledge.ts");
const { findSizingCharts } = await import("../lib/sizing-charts.ts");
const { canonicalizeBrand, isKnownBrand } = await import("../lib/brand-normalize.ts");
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

function style(
  styleName: string,
  productLine: string,
  visualFingerprint: string,
  fabricTech: string[],
): BrandStyleKnowledge {
  return {
    styleName,
    aliases: [],
    productLine,
    department: "Unisex",
    category: "jacket",
    visualFingerprint,
    fabricTech,
    era: null,
    msrpBand: null,
    keywords: [],
  };
}

function pack(
  brand: string,
  key: string,
  styles: BrandStyleKnowledge[],
  decoders: BrandKnowledgePack["decoders"] = [],
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["outdoor", "technical"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

// Packs shaped as the US-1711 resolver returns for the 00453-seeded rows,
// carrying the seeded fingerprints verbatim.
function seededColumbiaPack(): BrandKnowledgePack {
  return pack("Columbia", "columbia", [
    style(
      "Bugaboo",
      "Interchange",
      "The long-running INTERCHANGE 3-in-1: an Omni-Tech shell with a zip-out liner, each wearable alone. vs Whirlibird: both are Interchange parkas, so the system does NOT separate them — the LINER does (Bugaboo's liner is classically a fleece; Whirlibird's is an Omni-Heat insulated liner). Confirm BOTH pieces are present before listing it as 3-in-1.",
      ["Omni-Tech", "Omni-Shield"],
    ),
    style(
      "Whirlibird",
      "Interchange",
      "The Omni-Heat INTERCHANGE parka — a waterproof Omni-Tech shell over a zip-out insulated liner with the silver reflective dot lining. The dotted liner is what separates it on sight from the Bugaboo.",
      ["Omni-Tech", "Omni-Heat"],
    ),
  ]);
}

function seededMarmotPack(): BrandKnowledgePack {
  return pack("Marmot", "marmot", [
    style(
      "PreCip",
      "PreCip",
      "Uses Marmot's OWN NanoPro/MemBrain membrane — NOT Gore-Tex — with taped seams and PitZips. The tag wordmark is the call: MemBrain/NanoPro here vs GORE-TEX on the Minimalist, two shells that look nearly identical but comp very differently.",
      ["NanoPro", "MemBrain"],
    ),
    style(
      "Minimalist",
      "Minimalist",
      "The GORE-TEX (Paclite) rain shell — the licensed-membrane sibling of the PreCip and a materially more valuable jacket. If the tag says GORE-TEX it is not a PreCip.",
      ["GORE-TEX", "GORE-TEX Paclite"],
    ),
  ]);
}

Deno.test("US-1734: the Columbia prompt block carries the Interchange liner disambiguation", () => {
  const block = brandPackPromptBlock(seededColumbiaPack());
  assert(block.includes("Bugaboo"), "names Bugaboo");
  assert(block.includes("Whirlibird"), "names Whirlibird");
  // The whole Bugaboo-vs-Whirlibird call: BOTH are Interchange, so the system is
  // not the separator — the liner is.
  assert(/INTERCHANGE/.test(block), "the Interchange system is named");
  assert(/LINER does/.test(block), "the liner is the stated separator");
  // The Omni- wordmark is the identity, and it must reach the prompt as fabric.
  assert(/Omni-Tech/.test(block), "Omni-Tech reaches the block");
  assert(/Omni-Heat/.test(block), "Omni-Heat reaches the block");
  // Columbia's item number is a retailer SKU — the block must not invite the AI
  // to transcribe a code as though it were decodable.
  assert(
    !/transcribe it VERBATIM/i.test(block),
    "no false decoder hint (Columbia has none)",
  );
});

Deno.test("US-1734: the Marmot prompt block separates the two lookalike shells by MEMBRANE", () => {
  const block = brandPackPromptBlock(seededMarmotPack());
  assert(block.includes("PreCip"), "names PreCip");
  assert(block.includes("Minimalist"), "names Minimalist");
  // The trap: the jackets look alike, so the membrane wordmark — not the
  // silhouette — is the tell, and it is worth real money.
  assert(/MemBrain/.test(block), "MemBrain named");
  assert(/GORE-TEX/.test(block), "Gore-Tex named");
  assert(/NOT Gore-Tex/.test(block), "PreCip is explicitly not Gore-Tex");
  assert(
    !/transcribe it VERBATIM/i.test(block),
    "no false decoder hint (Marmot's item number is a retailer SKU)",
  );
});

Deno.test("US-1734: Arc'teryx is the only brand in the group that invites a code transcription", () => {
  const arcteryx = pack("Arc'teryx", "arcteryx", [], [
    {
      decoderKind: "style_name",
      description:
        'Arc\'teryx MODEL + weight-class SUFFIX printed on the garment/tag (SL/LT/AR/SV/MX/FL) — e.g. "Atom LT", "Beta AR".',
      pattern:
        "^(?<style>(?:Alpha|Beta|Gamma|Atom|Cerium)\\s+(?:SL|LT|AR|SV|MX|FL))$",
      extractionRules: {},
      examples: [],
    },
  ]);
  const block = brandPackPromptBlock(arcteryx);
  assert(
    /transcribe it VERBATIM/i.test(block),
    "Arc'teryx carries the decoder hint (its model+suffix is garment-printed)",
  );
  // The suffix system is the whole point — it has to survive into the prompt.
  assert(/SUFFIX/i.test(block), "the suffix system reaches the block");

  // Every other brand in the group is decoder-less by design.
  for (const [brand, key] of [
    ["Columbia", "columbia"],
    ["Marmot", "marmot"],
    ["REI Co-op", "reicoop"],
    ["L.L.Bean", "llbean"],
    ["Mountain Hardwear", "mountainhardwear"],
  ]) {
    const b = brandPackPromptBlock(pack(brand, key, [
      style("X", "X", "a fingerprint", []),
    ]));
    assert(
      !/transcribe it VERBATIM/i.test(b),
      `${brand} must not invite a code transcription (it has no decodable code)`,
    );
  }
});

Deno.test("US-1734: the Arc'teryx block carries the Atom-vs-Cerium fill call", () => {
  const block = brandPackPromptBlock(
    pack("Arc'teryx", "arcteryx", [
      style(
        "Atom",
        "Atom",
        "Coreloft SYNTHETIC insulation (not down) under a Tyono face. Atom LT has stretch FLEECE SIDE PANELS for breathability — look at the side body, that is the tell — while Atom AR is the warmer, fully-insulated winter version.",
        ["Coreloft", "Tyono"],
      ),
      style(
        "Cerium",
        "Cerium",
        "The DOWN sibling of the Atom — 850-fill down with synthetic Coreloft placed in the moisture-prone zones. Down vs synthetic is the Cerium-vs-Atom call.",
        ["850 fill down", "Coreloft"],
      ),
    ]),
  );
  // Synthetic vs down is the money call between the two insulated lines.
  assert(/SYNTHETIC/.test(block), "Atom is stated synthetic");
  assert(/DOWN sibling/.test(block), "Cerium is stated down");
  // And within Atom, the suffix is the sub-call — LT has the fleece side panels.
  assert(/FLEECE SIDE PANELS/.test(block), "the Atom LT side-panel tell survives");
});

Deno.test("US-1734: the new outdoor aliases canonicalize (were passthrough-only before)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("rei co-op") into the prompt block and the eBay Brand aspect.
  assertEquals(canonicalizeBrand("rei co-op"), "REI Co-op");
  assertEquals(canonicalizeBrand("REI"), "REI Co-op");
  assertEquals(canonicalizeBrand("Recreational Equipment Inc"), "REI Co-op");
  assertEquals(canonicalizeBrand("mountain hardwear"), "Mountain Hardwear");
  assertEquals(canonicalizeBrand("MOUNTAINHARDWEAR"), "Mountain Hardwear");
  assert(isKnownBrand("rei co-op"), "REI Co-op is now a curated entry");
  assert(isKnownBrand("mountain hardwear"), "Mountain Hardwear is now a curated entry");

  // The four that were already curated still canonicalize through the group's
  // punctuation variants (brandKey strips non-alphanumerics).
  assertEquals(canonicalizeBrand("arc'teryx"), "Arc'teryx");
  assertEquals(canonicalizeBrand("ARCTERYX"), "Arc'teryx");
  assertEquals(canonicalizeBrand("L.L. Bean"), "L.L.Bean");
  assertEquals(canonicalizeBrand("columbia sportswear"), "Columbia");

  // A bare "bean" must NOT rebrand to L.L.Bean — it is an ordinary word, so it
  // stays a passthrough rather than minting a brand from a stray tag token.
  assert(!isKnownBrand("bean"), "a bare 'bean' is not a curated entry");
  assertEquals(canonicalizeBrand("bean"), "bean");
});

Deno.test("US-1734: the group's charts are reachable per brand + are BODY measurements", () => {
  const cases: Array<[string, string, string]> = [
    ["Columbia", "jacket", "Men"],
    ["Columbia", "fleece", "Women"],
    ["Columbia", "pant", "Men"],
    ["Arc'teryx", "shell", "Men"],
    ["Arc'teryx", "jacket", "Women"],
    ["Marmot", "rain jacket", "Men"],
    ["REI Co-op", "jacket", "Men"],
    ["L.L.Bean", "flannel", "Men"],
    ["L.L.Bean", "pant", "Men"],
    ["Mountain Hardwear", "down", "Men"],
  ];
  for (const [brand, category, department] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand && c.department === department),
      `${brand} ${department} chart reachable for "${category}"`,
    );
  }

  // This group's basis error runs OPPOSITE to activewear: an outdoor shell is cut
  // with layering room, so its FLAT chest measures above the body chest it is
  // sized to. Every chart must therefore say which basis it is.
  const group = [
    "Columbia",
    "Arc'teryx",
    "Marmot",
    "REI Co-op",
    "L.L.Bean",
    "Mountain Hardwear",
  ];
  for (const brand of group) {
    const charts = findSizingCharts(brand, "jacket")
      .concat(findSizingCharts(brand, "top"))
      .concat(findSizingCharts(brand, "pant"));
    const mine = charts.filter((c) => c.brand === brand);
    assert(mine.length > 0, `${brand} has at least one chart`);
    for (const c of mine) {
      assert(/BODY/i.test(c.note ?? ""), `${brand} ${c.garment} note states the BODY basis`);
    }
  }
});

Deno.test("US-1734: L.L.Bean's chart warns that the classic cut runs GENEROUS", () => {
  const charts = findSizingCharts("L.L.Bean", "flannel");
  const men = charts.find((c) => c.brand === "L.L.Bean" && c.department === "Men");
  assert(men, "men's tops chart present");
  // The costliest Bean error: trusting the tag. A body chart cannot predict the
  // flat measurement of a deliberately roomy garment.
  assert(/GENEROUS/.test(men!.note ?? ""), "note states the generous cut");
  assert(
    /does NOT predict the flat measurement/.test(men!.note ?? ""),
    "note states that the body chart does not predict the flat measurement",
  );
});

Deno.test("US-1734: Columbia + Arc'teryx no longer double-match the shared outerwear chart", () => {
  // Before 00453 the shared 00389 "The North Face / Patagonia (outerwear)" chart
  // also claimed columbia + arcteryx. Now that each has its OWN chart, leaving
  // them on the shared row would return TWO charts with the same numbers for one
  // brand, competing for the 3-chart prompt budget.
  for (const brand of ["Columbia", "Arc'teryx"]) {
    const charts = findSizingCharts(brand, "jacket");
    assert(
      !charts.some((c) => c.brand.includes("The North Face / Patagonia")),
      `${brand} must not also match the shared outerwear chart`,
    );
    assert(
      charts.every((c) => c.brand === brand),
      `${brand} resolves only its own charts`,
    );
  }

  // The shared chart still serves the two brands that have no own-brand chart —
  // narrowing it must not strand them.
  for (const brand of ["The North Face", "Patagonia"]) {
    const charts = findSizingCharts(brand, "jacket");
    assert(
      charts.some((c) => c.brand === "The North Face / Patagonia (outerwear)"),
      `${brand} still reaches the shared outerwear chart`,
    );
  }
});
