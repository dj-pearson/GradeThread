// US-1728: verify Gucci content (migration 00400). 6-digit style decoder + line
// fingerprints + never-authenticate discipline.
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

const line = (name: string, fp: string): BrandStyleKnowledge => ({
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

function seededGucciPack(): BrandKnowledgePack {
  return {
    brand: "Gucci",
    key: "gucci",
    known: true,
    aliases: ["gucci"],
    categoryFocus: ["luxury"],
    authenticationTells: [{ tell: "NEVER auto-authenticate", detail: "a serial proves nothing" }],
    tagEras: [],
    styles: [
      line("GG Supreme", "Beige/ebony GG-monogram COATED CANVAS."),
      line("Marmont", "Matelasse CHEVRON-quilted leather with antique-gold double-G."),
    ],
    decoders: [
      {
        decoderKind: "style_number",
        description: "Gucci 6-digit style number",
        pattern: "^(?<style>[0-9]{6})$",
        extractionRules: { fieldMap: { style: "styleCode" }, confidence: 0.6 },
        examples: [],
      },
    ],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1728: the Gucci 6-digit style decoder matches, rejects others", () => {
  const specs = decoderSpecsFromPack(seededGucciPack());
  assertEquals(decodeTagCode("gucci", "123456", specs)!.styleCode, "123456");
  assertEquals(decodeTagCode("gucci", "84090", specs), null); // 5-digit (patagonia)
  assertEquals(decodeTagCode("gucci", "SD1160", specs), null); // LV date code
});

Deno.test("US-1728: prompt block carries line fingerprints + never-authenticate note", () => {
  const block = brandPackPromptBlock(seededGucciPack());
  assert(block.includes("GG Supreme"));
  assert(block.includes("Marmont"));
  assert(block.toLowerCase().includes("chevron")); // Marmont fingerprint
  assert(block.toLowerCase().includes("never assert authenticity"));
});
