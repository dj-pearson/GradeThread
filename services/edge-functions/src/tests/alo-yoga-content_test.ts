// US-1731: verify the Alo Yoga content (migration 00447) is correct + consumable
// by the engine — the style fingerprints render into the extract prompt so the AI
// can tell Airlift from Airbrush (the single most-confused Alo pair), and the
// women's size charts are reachable via findSizingCharts. Alo has NO tag-code
// decoder (identity is read from fabric hand + care tag), so there's no
// decodeTagCode case here — unlike Lululemon's size-dot.
// brand-knowledge.ts + sizing-charts.ts import supabase at load → dummy env first.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { brandPackPromptBlock } = await import("../lib/brand-knowledge.ts");
const { findSizingCharts } = await import("../lib/sizing-charts.ts");
import type { BrandKnowledgePack } from "../lib/brand-knowledge.ts";

// A pack shaped EXACTLY as the US-1711 resolver returns it for the 00447-seeded
// Alo rows (styles + colorways; no decoder).
function seededAloPack(): BrandKnowledgePack {
  return {
    brand: "Alo Yoga",
    key: "aloyoga",
    known: true,
    aliases: ["alo", "aloyoga", "aloyogausa"],
    categoryFocus: ["activewear", "yoga", "athleisure", "leggings"],
    authenticationTells: [
      { tell: "RN 87370", detail: "Care-tag RN 87370 = Color Image Apparel (Alo's parent); never proves authenticity." },
    ],
    tagEras: [],
    styles: [
      {
        styleName: "Airlift Legging",
        aliases: ["airlift"],
        productLine: "Airlift",
        department: "Women",
        category: "legging",
        visualFingerprint:
          "Lightweight performance knit with a subtle SHEEN; firm locked-in athletic compression and a wide zero-slip HIGH-RISE waistband. Lighter and shinier than Airbrush.",
        fabricTech: ["Airlift"],
        era: null,
        msrpBand: "$78-$148",
        keywords: ["airlift", "legging", "high waist", "7/8"],
      },
      {
        styleName: "Airbrush Legging",
        aliases: ["airbrush"],
        productLine: "Airbrush",
        department: "Women",
        category: "legging",
        visualFingerprint:
          "Thicker, MATTE, cotton-esque hand with sculpting all-over compression; more durable and heavier than Airlift.",
        fabricTech: ["Airbrush"],
        era: null,
        msrpBand: "$88-$138",
        keywords: ["airbrush", "legging", "moto", "matte"],
      },
    ],
    decoders: [],
    colorways: [
      { colorName: "Black", aliases: ["black"], hex: "#000000", years: null },
      { colorName: "Anthracite", aliases: ["anthracite"], hex: null, years: null },
    ],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1731: the prompt block carries the Airlift-vs-Airbrush disambiguation", () => {
  const block = brandPackPromptBlock(seededAloPack());
  assert(block.includes("Airlift Legging"), "names Airlift");
  assert(block.includes("Airbrush Legging"), "names Airbrush");
  // The fastest disambiguator: sheen (Airlift) vs matte (Airbrush).
  assert(/sheen/i.test(block), "Airlift sheen fingerprint");
  assert(/matte/i.test(block), "Airbrush matte fingerprint");
  assert(block.includes("Airlift") && block.includes("Airbrush"), "fabric tech listed");
  assert(block.includes("Black"), "named colorway present");
  // No decoder → the block must NOT claim a transcribable tag code.
  assert(!/transcribe it VERBATIM/i.test(block), "no false decoder hint");
});

Deno.test("US-1731: Alo women's size charts are reachable by brand + category", () => {
  const bottoms = findSizingCharts("Alo Yoga", "legging");
  assert(bottoms.length >= 1, "a bottoms chart resolves");
  assert(
    bottoms.every((c) => c.brand === "Alo Yoga"),
    "brand match isolates Alo charts",
  );
  const women = bottoms.find((c) => c.department === "Women");
  assert(women, "women's bottoms chart present");
  // XS waist row is the sourced Alo value.
  const xs = women!.rows.find((r) => r.size === "XS");
  assertEquals(xs?.measurements.waist, "25-26.5");

  const tops = findSizingCharts("aloyoga", "top");
  assert(tops.some((c) => c.department === "Women" && c.garment === "Tops"), "women's tops chart present");
});

Deno.test("US-1731: an alias ('alo') still resolves the Alo charts", () => {
  const charts = findSizingCharts("alo", "legging");
  assert(charts.some((c) => c.brand === "Alo Yoga"), "alias matches");
});
