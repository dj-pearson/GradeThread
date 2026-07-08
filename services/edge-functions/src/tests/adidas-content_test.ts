// US-1720: verify adidas/Yeezy content (migration 00392). A THIRD decoder format
// (article number, 2 letters + 4 digits) seeded as pure data.
import { assert, assertEquals } from "@std/assert";
import { decodeTagCode } from "../lib/brand-decoders.ts";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { brandPackPromptBlock, decoderSpecsFromPack } = await import(
  "../lib/brand-knowledge.ts"
);
const { enrichExtractionWithBrandKnowledge } = await import(
  "../lib/ai-extract.ts"
);
import type { BrandKnowledgePack, BrandStyleKnowledge } from "../lib/brand-knowledge.ts";
import type { DecodedExtraction } from "../lib/ai-extract.ts";

const style = (
  styleName: string,
  line: string,
  fingerprint: string,
  keywords: string[],
): BrandStyleKnowledge => ({
  styleName,
  aliases: [],
  productLine: line,
  department: "Unisex",
  category: "pant",
  visualFingerprint: fingerprint,
  fabricTech: [],
  era: null,
  msrpBand: null,
  keywords,
});

function seededAdidasPack(): BrandKnowledgePack {
  return {
    brand: "adidas",
    key: "adidas",
    known: true,
    aliases: ["adidas"],
    categoryFocus: ["sportswear", "originals"],
    authenticationTells: [
      { tell: "Trefoil vs 3-Bar", detail: "Trefoil = Originals; 3-bar = Performance." },
    ],
    tagEras: [],
    styles: [
      style("Tiro Track Pant", "Performance", "tapered track pant with ankle zips and 3-stripes down the legs", ["tiro", "3-stripes"]),
      style("Firebird Track Jacket", "Originals", "Originals Trefoil track jacket with 3-stripes on the sleeves and a contrast stand collar", ["firebird", "trefoil", "originals"]),
    ],
    decoders: [
      {
        decoderKind: "article_number",
        description: "adidas article number: 2 letters + 4 digits",
        pattern: "^(?<article>[A-Z]{1,2}[0-9]{4,5})$",
        extractionRules: { fieldMap: { article: "styleCode" }, confidence: 0.8 },
        examples: [],
      },
    ],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1720: the pure-data adidas article decoder drives decodeTagCode", () => {
  const specs = decoderSpecsFromPack(seededAdidasPack());
  const r = decodeTagCode("adidas", "GX1234", specs);
  assert(r !== null);
  assertEquals(r!.styleCode, "GX1234");
  // must NOT match a Nike (dash) or Lululemon (dot) code
  assertEquals(decodeTagCode("adidas", "CW1234-001", specs), null);
  assertEquals(decodeTagCode("adidas", "WU1ABC.0119", specs), null);
});

Deno.test("US-1720: prompt block carries the Trefoil(Originals) vs Performance disambiguation", () => {
  const block = brandPackPromptBlock(seededAdidasPack());
  assert(block.includes("Tiro Track Pant"));
  assert(block.includes("Firebird Track Jacket"));
  assert(block.includes("Trefoil"));
  assert(block.includes("3-stripes"));
});

Deno.test("US-1720: an adidas article code confirms the canonical brand 'adidas'", () => {
  const decoded: DecodedExtraction = {
    suggestions: {},
    attributes: {
      style_code: { values: ["GX1234"], confidence: 0.3, source: "photo:tag" },
    },
    research: null,
    conditionSummary: null,
    conflicts: [],
    measurements: null,
    ebayCategoryQuery: null,
  };
  const { decoded: out } = enrichExtractionWithBrandKnowledge(decoded, seededAdidasPack());
  assertEquals(out.suggestions.brand?.value, "adidas");
  assertEquals(out.suggestions.brand?.source, "decoder");
});
