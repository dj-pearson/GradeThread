// US-1724: verify The North Face content (migration 00396). NF0A style-code
// decoder + down-vs-synthetic-vs-fleece fingerprints.
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

function seededTnfPack(): BrandKnowledgePack {
  return {
    brand: "The North Face",
    key: "thenorthface",
    known: true,
    aliases: ["northface", "tnf"],
    categoryFocus: ["outdoor"],
    authenticationTells: [{ tell: "Summit Series", detail: "premium technical line" }],
    tagEras: [],
    styles: [
      style("Nuptse", "Boxy 700-fill DOWN puffer with horizontal baffles.", ["700-fill down"]),
      style("ThermoBall", "ThermoBall SYNTHETIC-insulated jacket, small round baffles.", ["ThermoBall"]),
      style("Denali", "Polartec FLEECE jacket with nylon shoulder overlays.", ["Polartec"]),
    ],
    decoders: [
      {
        decoderKind: "style_number",
        description: "TNF NF0A style code",
        pattern: "^(?<style>NF[0-9A-Z]{6,8})$",
        extractionRules: { fieldMap: { style: "styleCode" }, confidence: 0.8 },
        examples: [],
      },
    ],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1724: the NF0A style-code decoder matches, rejects others", () => {
  const specs = decoderSpecsFromPack(seededTnfPack());
  assertEquals(decodeTagCode("thenorthface", "NF0A3XY3", specs)!.styleCode, "NF0A3XY3");
  assertEquals(decodeTagCode("thenorthface", "GX1234", specs), null); // adidas
  assertEquals(decodeTagCode("thenorthface", "84090", specs), null); // patagonia
});

Deno.test("US-1724: prompt block carries the down-vs-synthetic-vs-fleece disambiguation", () => {
  const block = brandPackPromptBlock(seededTnfPack());
  assert(block.includes("Nuptse"));
  assert(block.includes("ThermoBall"));
  assert(block.includes("Denali"));
  assert(block.toLowerCase().includes("down")); // Nuptse
  assert(block.toLowerCase().includes("synthetic")); // ThermoBall
  assert(block.includes("Polartec")); // Denali fleece
});

Deno.test("US-1724: a TNF style code confirms 'The North Face'", () => {
  const decoded: DecodedExtraction = {
    suggestions: {},
    attributes: {
      style_code: { values: ["NF0A3XY3"], confidence: 0.3, source: "photo:tag" },
    },
    research: null,
    conditionSummary: null,
    conflicts: [],
    measurements: null,
    ebayCategoryQuery: null,
  };
  const { decoded: out } = enrichExtractionWithBrandKnowledge(decoded, seededTnfPack());
  assertEquals(out.suggestions.brand?.value, "The North Face");
  assertEquals(out.suggestions.brand?.source, "decoder");
});
