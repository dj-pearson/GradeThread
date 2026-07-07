// US-1718: verify the Lululemon content (migration 00390) is correct + consumable
// by the engine — the DB decoder spec drives decodeTagCode, and the style
// fingerprints render into the extract prompt so the AI can tell ABC from
// Commission. brand-knowledge.ts imports supabase at load → dummy env first.
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
import type { BrandKnowledgePack } from "../lib/brand-knowledge.ts";

// A pack shaped EXACTLY as the US-1711 resolver returns it for the 00390-seeded
// Lululemon rows (styles + the style_number decoder from brand_style_codes).
function seededLululemonPack(): BrandKnowledgePack {
  return {
    brand: "Lululemon",
    key: "lululemon",
    known: true,
    aliases: ["lululemon", "lulu"],
    categoryFocus: ["athleisure", "activewear"],
    authenticationTells: [{ tell: "Size dot", detail: "numeric size in the pocket circle" }],
    tagEras: [],
    styles: [
      {
        styleName: "ABC Pant",
        aliases: [],
        productLine: "ABC",
        department: "Men",
        category: "pant",
        visualFingerprint: "5-pocket pant with jeans-style pockets and the ABC diamond gusset; NOT chino-cut",
        fabricTech: ["Warpstreme", "Utilitech"],
        era: null,
        msrpBand: null,
        keywords: ["abc", "pant", "5-pocket"],
      },
      {
        styleName: "Commission Pant",
        aliases: [],
        productLine: "Commission",
        department: "Men",
        category: "pant",
        visualFingerprint: "chino-style: slanted front + welt back pockets, no gusset; dressier",
        fabricTech: ["Warpstreme", "WovenAir"],
        era: null,
        msrpBand: null,
        keywords: ["commission", "chino"],
      },
    ],
    decoders: [
      {
        decoderKind: "style_number",
        description: 'W/M + style code + color-initial + "." + SSYY',
        pattern:
          "^(?<gender>[WM])(?<style>[A-Z0-9]{3,5})(?<color>[A-Z])\\.(?<season>0[1-4])(?<year>\\d{2})$",
        extractionRules: {
          fieldMap: {
            gender: "gender",
            style: "styleCode",
            color: "colorInitial",
            season: "season",
            year: "year",
          },
          transforms: {
            gender: "genderCode",
            season: "seasonCode",
            year: "year2to4",
            color: "upper",
          },
          confidence: 0.9,
        },
        examples: [],
      },
    ],
    colorways: [{ colorName: "Black Cherry", aliases: [], hex: "#4b1e2f", years: null }],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1718: the DB-seeded style_number decoder drives decodeTagCode", () => {
  const specs = decoderSpecsFromPack(seededLululemonPack());
  assertEquals(specs.length, 1);
  const r = decodeTagCode("lululemon", "WU1ABC.0119", specs);
  assert(r !== null);
  assertEquals(r!.brand, "Lululemon");
  assertEquals(r!.gender, "Women");
  assertEquals(r!.season, "Spring"); // 01
  assertEquals(r!.year, "2019");
});

Deno.test("US-1718: the prompt block carries the ABC-vs-Commission disambiguation", () => {
  const block = brandPackPromptBlock(seededLululemonPack());
  assert(block.includes("ABC Pant"));
  assert(block.includes("Commission Pant"));
  assert(block.includes("5-pocket")); // ABC fingerprint
  assert(block.includes("chino")); // Commission fingerprint
  assert(block.includes("Warpstreme")); // fabric tech
  assert(block.toLowerCase().includes("verbatim")); // decoder hint: transcribe the code
  assert(block.includes("Black Cherry")); // colorway
});
