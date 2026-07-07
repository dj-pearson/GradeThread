// US-1725: verify Ralph Lauren content (migration 00397) — a fingerprint/tell-ONLY
// brand (no decoder). The sub-line value hierarchy must render into the prompt.
import { assert, assertEquals } from "@std/assert";

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
  category: "top",
  visualFingerprint: fp,
  fabricTech: [],
  era: null,
  msrpBand: null,
  keywords: [],
});

function seededRlPack(): BrandKnowledgePack {
  return {
    brand: "Ralph Lauren",
    key: "ralphlauren",
    known: true,
    aliases: ["ralphlauren", "poloralphlauren"],
    categoryFocus: ["preppy"],
    authenticationTells: [
      { tell: "Sub-brand hierarchy", detail: "Purple Label > RRL > Polo > Lauren > Chaps" },
    ],
    tagEras: [],
    styles: [
      line("Purple Label", "Top luxury tailored line, Italian-made; highest tier."),
      line("RRL (Double RL)", "Vintage-Americana workwear; HIGH value."),
      line("Polo Ralph Lauren", "Mainstream line with the polo-player pony."),
      line("Chaps", "Budget diffusion line — LOW value, NOT Polo Ralph Lauren."),
    ],
    decoders: [], // fingerprint/tell-only brand
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1725: RL has no decoder (fingerprint/tell-only)", () => {
  assertEquals(decoderSpecsFromPack(seededRlPack()).length, 0);
});

Deno.test("US-1725: prompt block carries the sub-line value hierarchy + auth note", () => {
  const block = brandPackPromptBlock(seededRlPack());
  assert(block.includes("Purple Label"));
  assert(block.includes("RRL"));
  assert(block.includes("Polo Ralph Lauren"));
  assert(block.includes("Chaps"));
  // the styles convey the tier, and an authentication note is present
  assert(block.toLowerCase().includes("budget")); // Chaps fingerprint
  assert(block.toLowerCase().includes("authentication"));
});
