// US-1732: verify the Athleta content (migration 00448) is correct + consumable
// by the engine — the fabric-line fingerprints render into the extract prompt so
// the AI can separate Athleta's confusable Powervita leggings (Salutation BRUSHED
// vs Elation SMOOTH) from the firmer SuperSonic Ultimate, and the refined women's
// size charts (with the numeric map) are reachable via findSizingCharts. Athleta
// has NO tag-code decoder (identity = fabric line + care-tag size), so there's no
// decodeTagCode case. brand-knowledge.ts + sizing-charts.ts import supabase at
// load → dummy env first.
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

// A pack shaped as the US-1711 resolver returns for the 00448-seeded Athleta rows.
function seededAthletaPack(): BrandKnowledgePack {
  return {
    brand: "Athleta",
    key: "athleta",
    known: true,
    aliases: ["athleta"],
    categoryFocus: ["activewear", "yoga", "athleisure", "womens"],
    authenticationTells: [
      { tell: "Fabric line IDs the legging", detail: "Salutation brushed vs Elation smooth vs Ultimate firm SuperSonic." },
    ],
    tagEras: [],
    styles: [
      {
        styleName: "Salutation Tight",
        aliases: ["salutation"],
        productLine: "Salutation",
        department: "Women",
        category: "legging",
        visualFingerprint:
          "BRUSHED, buttery-soft Powervita with a peached hand; Align-competitor for yoga/lounge. Softer face than the smooth Elation.",
        fabricTech: ["Powervita"],
        era: null,
        msrpBand: "$89-$99",
        keywords: ["salutation", "powervita", "yoga"],
      },
      {
        styleName: "Elation Tight",
        aliases: ["elation"],
        productLine: "Elation",
        department: "Women",
        category: "legging",
        visualFingerprint:
          "SMOOTH, sleek Powervita (not brushed) — moisture-wicking, performance sibling of the softer Salutation.",
        fabricTech: ["Powervita"],
        era: null,
        msrpBand: "$89-$99",
        keywords: ["elation", "powervita"],
      },
      {
        styleName: "Ultimate Tight",
        aliases: ["ultimate"],
        productLine: "Ultimate",
        department: "Women",
        category: "legging",
        visualFingerprint:
          "Firm-support SuperSonic with a smooth matte face and strong compression; running/training.",
        fabricTech: ["SuperSonic"],
        era: null,
        msrpBand: "$89-$109",
        keywords: ["ultimate", "supersonic", "compression"],
      },
    ],
    decoders: [],
    colorways: [
      { colorName: "Black", aliases: ["black"], hex: "#000000", years: null },
      { colorName: "Navy", aliases: ["navy"], hex: null, years: null },
    ],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1732: the prompt block carries the Salutation/Elation/Ultimate fabric disambiguation", () => {
  const block = brandPackPromptBlock(seededAthletaPack());
  assert(block.includes("Salutation Tight"), "names Salutation");
  assert(block.includes("Elation Tight"), "names Elation");
  assert(block.includes("Ultimate Tight"), "names Ultimate");
  // The Salutation-vs-Elation disambiguator: brushed vs smooth.
  assert(/brushed/i.test(block), "Salutation brushed fingerprint");
  assert(/smooth/i.test(block), "Elation smooth fingerprint");
  // The Powervita-vs-SuperSonic fabric split.
  assert(block.includes("Powervita"), "Powervita fabric listed");
  assert(block.includes("SuperSonic"), "SuperSonic fabric listed");
  assert(block.includes("Black"), "named colorway present");
  assert(!/transcribe it VERBATIM/i.test(block), "no false decoder hint (Athleta has none)");
});

Deno.test("US-1732: Athleta women's size charts (refined) are reachable + carry hip + numeric map", () => {
  const bottoms = findSizingCharts("Athleta", "legging");
  const women = bottoms.find((c) => c.brand === "Athleta" && c.department === "Women");
  assert(women, "women's bottoms chart present");
  const xxs = women!.rows.find((r) => r.size === "XXS");
  assertEquals(xxs?.measurements.waist, "24"); // sourced value
  assert(xxs?.measurements.hip, "hip is now populated (was refined in 00448)");
  assert(/numeric map/i.test(women!.note ?? ""), "note documents the numeric mapping");

  const tops = findSizingCharts("athleta", "top");
  assert(tops.some((c) => c.brand === "Athleta" && c.garment === "Tops"), "women's tops chart present");
});
