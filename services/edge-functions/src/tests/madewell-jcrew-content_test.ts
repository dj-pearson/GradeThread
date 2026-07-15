// US-1730: verify the Madewell & J.Crew content (migration 00450) is correct +
// consumable — the fit-name fingerprints render into the extract prompt so the AI
// separates Madewell's Perfect Vintage (tapered) from Roadtripper (skinny) and
// J.Crew's numbered chino fits (484 Slim / 770 Straight / 1040 Athletic), and the
// J.Crew size charts are reachable via findSizingCharts. Two related banners, one
// pack — each is decoder-less (fit name + item code, not a brand-unique code).
// brand-knowledge.ts + sizing-charts.ts import supabase at load → dummy env first.
import { assert } from "@std/assert";

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
import type { BrandKnowledgePack, BrandStyleKnowledge } from "../lib/brand-knowledge.ts";

function st(
  styleName: string,
  productLine: string,
  category: string,
  visualFingerprint: string,
  department: string,
  keywords: string[],
): BrandStyleKnowledge {
  return {
    styleName,
    aliases: [],
    productLine,
    department,
    category,
    visualFingerprint,
    fabricTech: [],
    era: null,
    msrpBand: null,
    keywords,
  };
}

function madewellPack(): BrandKnowledgePack {
  return {
    brand: "Madewell",
    key: "madewell",
    known: true,
    aliases: ["madewell"],
    categoryFocus: ["denim", "womens"],
    authenticationTells: [{ tell: "Fit name IDs the jean", detail: "Perfect Vintage tapered vs Roadtripper skinny." }],
    tagEras: [],
    styles: [
      st("The Perfect Vintage Jean", "The Perfect Vintage", "jean", "11in high rise, TAPERED leg, Magic Pockets.", "Women", ["perfect vintage", "tapered"]),
      st("Roadtripper Jean", "Roadtripper", "jean", "Soft stretch high-rise SKINNY (jegging-like).", "Women", ["roadtripper", "skinny"]),
    ],
    decoders: [],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

function jcrewPack(): BrandKnowledgePack {
  return {
    brand: "J.Crew",
    key: "jcrew",
    known: true,
    aliases: ["jcrew", "j crew", "j.crew"],
    categoryFocus: ["preppy", "chinos", "shirting"],
    authenticationTells: [{ tell: "Numbered chino fits", detail: "484 Slim / 770 Straight / 1040 Athletic." }],
    tagEras: [],
    styles: [
      st("484 Slim", "484", "pant", "SLIM chino — slim hip/thigh, tapered.", "Men", ["484", "slim"]),
      st("770 Straight", "770", "pant", "STRAIGHT fit — between 484 and 1040, moderate taper.", "Men", ["770", "straight"]),
      st("1040 Athletic", "1040", "pant", "ATHLETIC fit — roomy upper/lower leg.", "Men", ["1040", "athletic"]),
    ],
    decoders: [],
    colorways: [{ colorName: "Black", aliases: ["black"], hex: "#000000", years: null }],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1730: Madewell prompt block separates Perfect Vintage from Roadtripper", () => {
  const block = brandPackPromptBlock(madewellPack());
  assert(block.includes("The Perfect Vintage Jean"), "names Perfect Vintage");
  assert(block.includes("Roadtripper Jean"), "names Roadtripper");
  assert(/tapered/i.test(block), "Perfect Vintage tapered fingerprint");
  assert(/skinny/i.test(block), "Roadtripper skinny fingerprint");
});

Deno.test("US-1730: J.Crew prompt block carries the numbered fit map", () => {
  const block = brandPackPromptBlock(jcrewPack());
  assert(block.includes("484 Slim"), "484 present");
  assert(block.includes("770 Straight"), "770 present");
  assert(block.includes("1040 Athletic"), "1040 present");
  assert(/slim/i.test(block) && /straight/i.test(block) && /athletic/i.test(block), "fit descriptors present");
});

Deno.test("US-1730: J.Crew size charts (chinos + shirts) are reachable", () => {
  const chinos = findSizingCharts("J.Crew", "chino");
  assert(chinos.some((c) => c.brand === "J.Crew" && c.garment.startsWith("Chinos")), "chinos chart present");
  const shirts = findSizingCharts("jcrew", "shirt");
  assert(shirts.some((c) => c.brand === "J.Crew" && c.garment === "Shirts (alpha)"), "shirts chart present");
  // Madewell women's denim (00389) still resolves for the sister brand.
  const madewell = findSizingCharts("madewell", "jean");
  assert(madewell.some((c) => c.brand === "Madewell"), "Madewell denim chart still present");
});
