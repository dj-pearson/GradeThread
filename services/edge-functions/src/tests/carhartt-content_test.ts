// US-1722: verify Carhartt content (migration 00394). Classic style-code decoder
// (letter+digits) + silhouette fingerprints (Detroit vs Chore vs Active Jac).
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

const style = (name: string, fp: string, kw: string[]): BrandStyleKnowledge => ({
  styleName: name,
  aliases: [],
  productLine: "Workwear",
  department: "Unisex",
  category: "jacket",
  visualFingerprint: fp,
  fabricTech: [],
  era: null,
  msrpBand: null,
  keywords: kw,
});

function seededCarharttPack(): BrandKnowledgePack {
  return {
    brand: "Carhartt",
    key: "carhartt",
    known: true,
    aliases: ["carhartt"],
    categoryFocus: ["workwear"],
    authenticationTells: [{ tell: "Carhartt vs WIP", detail: "mainline vs pricier WIP" }],
    tagEras: [],
    styles: [
      style("Detroit Jacket", "Shorter, fitted blanket-lined duck jacket with a CORDUROY collar; sits at the waist.", ["detroit", "corduroy collar"]),
      style("Chore Coat", "Longer duck chore coat (mid-thigh), BUTTON front, three front pockets.", ["chore", "button front"]),
      style("Active Jac", "HOODED firm-duck jacket with a kangaroo pocket and sherpa lining.", ["active jac", "hooded"]),
    ],
    decoders: [
      {
        decoderKind: "style_number",
        description: "Carhartt classic style code",
        pattern: "^(?<style>[A-Z]{1,2}[0-9]{2,3})$",
        extractionRules: { fieldMap: { style: "styleCode" }, confidence: 0.75 },
        examples: [],
      },
    ],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1722: the Carhartt style-code decoder matches letter+digits, rejects others", () => {
  const specs = decoderSpecsFromPack(seededCarharttPack());
  assertEquals(decodeTagCode("carhartt", "J140", specs)!.styleCode, "J140");
  assertEquals(decodeTagCode("carhartt", "B01", specs)!.styleCode, "B01");
  assertEquals(decodeTagCode("carhartt", "GX1234", specs), null); // adidas (4 digits)
  assertEquals(decodeTagCode("carhartt", "501", specs), null); // no letter
});

Deno.test("US-1722: prompt block carries the Detroit-vs-Chore-vs-Active disambiguation", () => {
  const block = brandPackPromptBlock(seededCarharttPack());
  assert(block.includes("Detroit Jacket"));
  assert(block.includes("Chore Coat"));
  assert(block.includes("Active Jac"));
  assert(block.toLowerCase().includes("corduroy collar")); // Detroit
  assert(block.toLowerCase().includes("hooded")); // Active Jac
});

Deno.test("US-1722: a Carhartt style code confirms the canonical brand 'Carhartt'", () => {
  const decoded: DecodedExtraction = {
    suggestions: {},
    attributes: {
      style_code: { values: ["J140"], confidence: 0.3, source: "photo:tag" },
    },
    research: null,
    conditionSummary: null,
    conflicts: [],
    measurements: null,
    ebayCategoryQuery: null,
    visualRulings: [],
  };
  const { decoded: out } = enrichExtractionWithBrandKnowledge(decoded, seededCarharttPack());
  assertEquals(out.suggestions.brand?.value, "Carhartt");
  assertEquals(out.suggestions.brand?.source, "decoder");
});
