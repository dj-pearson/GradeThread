// US-1723: verify Patagonia content (migration 00395). 5-digit style-number
// decoder + fabric-tech fingerprints (Nano Puff vs Down Sweater).
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

const style = (name: string, fp: string, fab: string[]): BrandStyleKnowledge => ({
  styleName: name,
  aliases: [],
  productLine: name,
  department: "Unisex",
  category: "jacket",
  visualFingerprint: fp,
  fabricTech: fab,
  era: null,
  msrpBand: null,
  keywords: [],
});

function seededPatagoniaPack(): BrandKnowledgePack {
  return {
    brand: "Patagonia",
    key: "patagonia",
    known: true,
    aliases: ["patagonia"],
    categoryFocus: ["outdoor"],
    authenticationTells: [{ tell: "Insulation type", detail: "synthetic vs down disambiguates" }],
    tagEras: [],
    styles: [
      style("Nano Puff", "PrimaLoft synthetic with sewn-through brick baffles, matte shell.", ["PrimaLoft"]),
      style("Down Sweater", "800-fill goose DOWN, horizontal baffles, shinier shell; loftier than Nano Puff.", ["800-fill down"]),
    ],
    decoders: [
      {
        decoderKind: "style_number",
        description: "Patagonia 5-digit style number",
        pattern: "^(?<style>[0-9]{5})$",
        extractionRules: { fieldMap: { style: "styleCode" }, confidence: 0.7 },
        examples: [],
      },
    ],
    colorways: [{ colorName: "Classic Navy", aliases: [], hex: "#212a3d", years: null }],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1723: the 5-digit style-number decoder matches, rejects others", () => {
  const specs = decoderSpecsFromPack(seededPatagoniaPack());
  assertEquals(decodeTagCode("patagonia", "84090", specs)!.styleCode, "84090");
  assertEquals(decodeTagCode("patagonia", "501", specs), null); // 3 digits
  assertEquals(decodeTagCode("patagonia", "GX1234", specs), null); // has letters
});

Deno.test("US-1723: prompt block carries the Nano-Puff-vs-Down-Sweater disambiguation", () => {
  const block = brandPackPromptBlock(seededPatagoniaPack());
  assert(block.includes("Nano Puff"));
  assert(block.includes("Down Sweater"));
  assert(block.includes("PrimaLoft")); // synthetic fabric tech
  assert(block.toLowerCase().includes("down")); // down fill
  assert(block.includes("Classic Navy")); // colorway
});

Deno.test("US-1723: a Patagonia style number confirms the canonical brand 'Patagonia'", () => {
  const decoded: DecodedExtraction = {
    suggestions: {},
    attributes: {
      style_code: { values: ["84090"], confidence: 0.3, source: "photo:tag" },
    },
    research: null,
    conditionSummary: null,
    conflicts: [],
    measurements: null,
    ebayCategoryQuery: null,
  };
  const { decoded: out } = enrichExtractionWithBrandKnowledge(decoded, seededPatagoniaPack());
  assertEquals(out.suggestions.brand?.value, "Patagonia");
  assertEquals(out.suggestions.brand?.source, "decoder");
});
