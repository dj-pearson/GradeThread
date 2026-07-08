// US-1721: verify Levi's content (migration 00393). Fit-number decoder (5NN,
// brand-scoped) + fit fingerprints (501 button-fly vs 505 zip-fly vs 511 slim).
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

const fit = (name: string, fp: string, kw: string[]): BrandStyleKnowledge => ({
  styleName: name,
  aliases: [],
  productLine: "Red Tab",
  department: "Men",
  category: "jeans",
  visualFingerprint: fp,
  fabricTech: [],
  era: null,
  msrpBand: null,
  keywords: kw,
});

function seededLevisPack(): BrandKnowledgePack {
  return {
    brand: "Levi's",
    key: "levis",
    known: true,
    aliases: ["levi", "levis"],
    categoryFocus: ["denim", "jeans"],
    authenticationTells: [{ tell: "Red tab", detail: "Big E = pre-1971 vintage" }],
    tagEras: [],
    styles: [
      fit("501", "Original Straight: BUTTON FLY, higher rise, straight leg.", ["501", "button fly"]),
      fit("505", "Regular Straight: ZIP FLY, mid rise, roomier thigh than the 501.", ["505", "zip fly"]),
      fit("511", "Slim: zip fly, slim through hip and thigh.", ["511", "slim"]),
    ],
    decoders: [
      {
        decoderKind: "lot_number",
        description: "Levi's fit/lot number (5NN)",
        pattern: "^(?<fit>5[0-9]{2})$",
        extractionRules: { fieldMap: { fit: "styleCode" }, confidence: 0.7 },
        examples: [],
      },
    ],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1721: the brand-scoped fit-number decoder matches 5NN, rejects others", () => {
  const specs = decoderSpecsFromPack(seededLevisPack());
  assertEquals(decodeTagCode("levis", "501", specs)!.styleCode, "501");
  assertEquals(decodeTagCode("levis", "511", specs)!.styleCode, "511");
  assertEquals(decodeTagCode("levis", "GX1234", specs), null); // adidas
  assertEquals(decodeTagCode("levis", "401", specs), null); // not a 5NN fit
});

Deno.test("US-1721: prompt block carries the button-fly-vs-zip-fly fit disambiguation", () => {
  const block = brandPackPromptBlock(seededLevisPack());
  assert(block.includes("501"));
  assert(block.includes("505"));
  assert(block.toLowerCase().includes("button fly"));
  assert(block.toLowerCase().includes("zip fly"));
});

Deno.test("US-1721: a Levi's fit number confirms the canonical brand \"Levi's\"", () => {
  const decoded: DecodedExtraction = {
    suggestions: {},
    attributes: {
      style_code: { values: ["511"], confidence: 0.3, source: "photo:tag" },
    },
    research: null,
    conditionSummary: null,
    conflicts: [],
    measurements: null,
    ebayCategoryQuery: null,
  };
  const { decoded: out } = enrichExtractionWithBrandKnowledge(decoded, seededLevisPack());
  assertEquals(out.suggestions.brand?.value, "Levi's");
  assertEquals(out.suggestions.brand?.source, "decoder");
});
