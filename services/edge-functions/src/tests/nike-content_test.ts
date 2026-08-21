// US-1719: verify Nike/Jordan content (migration 00391). The Nike decoder is a
// DIFFERENT format seeded as PURE DATA (no transform) — this proves the engine
// generalizes. Also verifies the brand-confirmation fix yields canonical "Nike".
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

const nikeStyle = (
  styleName: string,
  fingerprint: string,
  fabric: string[],
): BrandStyleKnowledge => ({
  styleName,
  aliases: [],
  productLine: "Sportswear",
  department: "Unisex",
  category: "top",
  visualFingerprint: fingerprint,
  fabricTech: fabric,
  era: null,
  msrpBand: null,
  keywords: [],
});

// A pack shaped as the resolver returns it for the 00391-seeded Nike rows. The
// decoder has NO transforms — a regular format added as data alone.
function seededNikePack(): BrandKnowledgePack {
  return {
    brand: "Nike",
    key: "nike",
    known: true,
    aliases: ["nike"],
    categoryFocus: ["sportswear"],
    authenticationTells: [],
    tagEras: [],
    styles: [
      nikeStyle(
        "Tech Fleece",
        "bonded lightweight double-knit fleece, smooth face, zip pockets; NOT plain brushed fleece",
        ["Tech Fleece"],
      ),
      nikeStyle(
        "Club Fleece",
        "heavier classic brushed-back cotton-blend fleece, relaxed casual",
        ["Club Fleece"],
      ),
    ],
    decoders: [
      {
        decoderKind: "style_number",
        description: "Nike style number: 6-char + '-' + 3-digit colorway",
        pattern: "^(?<style>[A-Z0-9]{6})-(?<colorway>[0-9]{3})$",
        extractionRules: {
          fieldMap: { style: "styleCode", colorway: "colorway" },
          confidence: 0.85,
        },
        examples: [],
      },
    ],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1719: the pure-data Nike decoder (no transform) drives decodeTagCode", () => {
  const specs = decoderSpecsFromPack(seededNikePack());
  const r = decodeTagCode("nike", "CW1234-001", specs);
  assert(r !== null);
  assertEquals(r!.styleCode, "CW1234");
  assertEquals(r!.colorway, "001"); // untransformed — proves no transform needed
  // a Lululemon code must NOT match the Nike spec
  assertEquals(decodeTagCode("nike", "WU1ABC.0119", specs), null);
});

Deno.test("US-1719: prompt block carries the Tech-vs-Club fleece disambiguation", () => {
  const block = brandPackPromptBlock(seededNikePack());
  assert(block.includes("Tech Fleece"));
  assert(block.includes("Club Fleece"));
  assert(block.includes("bonded")); // Tech fingerprint
  assert(block.includes("brushed")); // Club fingerprint
});

Deno.test("US-1719: a Nike style code confirms the CANONICAL brand 'Nike' (not lowercase)", () => {
  const decoded: DecodedExtraction = {
    suggestions: {},
    attributes: {
      style_code: { values: ["CW1234-001"], confidence: 0.3, source: "photo:tag" },
    },
    research: null,
    conditionSummary: null,
    conflicts: [],
    measurements: null,
    ebayCategoryQuery: null,
    visualRulings: [],
  };
  const { decoded: out } = enrichExtractionWithBrandKnowledge(decoded, seededNikePack());
  assertEquals(out.suggestions.brand?.value, "Nike"); // canonical, from pack.brand
  assertEquals(out.suggestions.brand?.source, "decoder");
});
