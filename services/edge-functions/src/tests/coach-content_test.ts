// US-1726: verify Coach content (migration 00398). Boutique-vs-outlet decoder +
// the NEVER-auto-authenticate discipline surfacing in the prompt.
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

function seededCoachPack(): BrandKnowledgePack {
  return {
    brand: "Coach",
    key: "coach",
    known: true,
    aliases: ["coach"],
    categoryFocus: ["handbags"],
    authenticationTells: [
      { tell: "NEVER auto-authenticate", detail: "a creed proves nothing on its own" },
    ],
    tagEras: [],
    styles: [
      line("Signature Canvas", "Coated-canvas CC monogram print."),
      line("Glovetanned Leather", "Full-grain leather, no monogram; higher-end."),
    ],
    decoders: [
      {
        decoderKind: "style_number",
        description: "Coach style number (F = outlet)",
        pattern: "^(?<style>F?[0-9]{4,6})$",
        extractionRules: { fieldMap: { style: "styleCode" }, confidence: 0.7 },
        examples: [],
      },
    ],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1726: the Coach style decoder captures F-prefix (outlet) and bare (boutique)", () => {
  const specs = decoderSpecsFromPack(seededCoachPack());
  assertEquals(decodeTagCode("coach", "F12345", specs)!.styleCode, "F12345");
  assertEquals(decodeTagCode("coach", "12345", specs)!.styleCode, "12345");
  assertEquals(decodeTagCode("coach", "NF0A3XY3", specs), null); // TNF
});

Deno.test("US-1726: prompt block surfaces the never-auto-authenticate note", () => {
  const block = brandPackPromptBlock(seededCoachPack());
  assert(block.includes("Signature Canvas"));
  assert(block.toLowerCase().includes("authentication"));
  assert(block.toLowerCase().includes("never assert authenticity"));
});
