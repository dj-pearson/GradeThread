// US-1727: verify Louis Vuitton content (migration 00399). Date-code FORMAT
// decoder + canvas fingerprints + never-authenticate discipline.
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
import type { BrandKnowledgePack, BrandStyleKnowledge } from "../lib/brand-knowledge.ts";

const canvas = (name: string, fp: string): BrandStyleKnowledge => ({
  styleName: name,
  aliases: [],
  productLine: name,
  department: "Unisex",
  category: "bag",
  visualFingerprint: fp,
  fabricTech: [],
  era: null,
  msrpBand: null,
  keywords: [],
});

function seededLvPack(): BrandKnowledgePack {
  return {
    brand: "Louis Vuitton",
    key: "louisvuitton",
    known: true,
    aliases: ["louisvuitton", "lv"],
    categoryFocus: ["luxury"],
    authenticationTells: [
      { tell: "NEVER auto-authenticate", detail: "a date code proves nothing" },
    ],
    tagEras: [],
    styles: [
      canvas("Monogram", "Brown LV monogram + floral coated canvas."),
      canvas("Damier Ebene", "Dark brown & black checkerboard canvas."),
    ],
    decoders: [
      {
        decoderKind: "date_code",
        description: "LV date code: 2 letters + 4 digits",
        pattern: "^(?<code>[A-Z]{2}[0-9]{4})$",
        extractionRules: { fieldMap: { code: "styleCode" }, confidence: 0.6 },
        examples: [],
      },
    ],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1727: the LV date-code format decoder matches, rejects others", () => {
  const specs = decoderSpecsFromPack(seededLvPack());
  assertEquals(decodeTagCode("louisvuitton", "SD1160", specs)!.styleCode, "SD1160");
  assertEquals(decodeTagCode("louisvuitton", "F12345", specs), null); // coach
  assertEquals(decodeTagCode("louisvuitton", "84090", specs), null); // patagonia
});

Deno.test("US-1727: prompt block carries canvas fingerprints + never-authenticate note", () => {
  const block = brandPackPromptBlock(seededLvPack());
  assert(block.includes("Monogram"));
  assert(block.includes("Damier Ebene"));
  assert(block.toLowerCase().includes("never assert authenticity"));
});
