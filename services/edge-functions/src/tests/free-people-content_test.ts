// US-1729: verify the Free People content (migration 00449) is correct + consumable
// by the engine — the SUB-LINE fingerprints render into the extract prompt so the
// AI separates We The Free (denim) / Intimately (lingerie) / FP Movement
// (activewear) / FP One / free-est under the one "Free People" umbrella, and the
// women's size charts (tops/dresses alpha + denim numeric) are reachable via
// findSizingCharts. Free People has NO tag-code decoder (identity = printed
// sub-line + care-tag size). brand-knowledge.ts + sizing-charts.ts import supabase
// at load → dummy env first.
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

// A pack shaped as the US-1711 resolver returns for the 00449-seeded FP rows.
function seededFreePeoplePack(): BrandKnowledgePack {
  const line = (
    styleName: string,
    productLine: string,
    category: string,
    visualFingerprint: string,
    keywords: string[],
  ) => ({
    styleName,
    aliases: [],
    productLine,
    department: "Women",
    category,
    visualFingerprint,
    fabricTech: [] as string[],
    era: null,
    msrpBand: null,
    keywords,
  });
  return {
    brand: "Free People",
    key: "freepeople",
    known: true,
    aliases: ["freepeople", "fp", "free people"],
    categoryFocus: ["boho", "dresses", "denim", "activewear", "intimates"],
    authenticationTells: [
      { tell: "Sub-line on the tag IS the identity", detail: "We The Free / Intimately / FP Movement / FP One / free-est." },
    ],
    tagEras: [],
    styles: [
      line("We The Free", "We The Free", "denim", "Heritage DENIM, jackets, casual tops. Tag reads 'We The Free' / WTF.", ["we the free", "denim"]),
      line("Intimately", "Intimately", "intimates", "Lingerie, slip dresses, bralettes, loungewear. Tag reads 'Intimately'.", ["intimately", "slip"]),
      line("FP Movement", "FP Movement", "activewear", "Activewear — leggings, sports bras. A DISTINCT athleisure sub-line on its own tag.", ["fp movement", "activewear"]),
    ],
    decoders: [],
    colorways: [
      { colorName: "Black", aliases: ["black"], hex: "#000000", years: null },
      { colorName: "Ivory", aliases: ["ivory"], hex: null, years: null },
    ],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1729: the prompt block carries the sub-line disambiguation", () => {
  const block = brandPackPromptBlock(seededFreePeoplePack());
  assert(block.includes("We The Free"), "names We The Free");
  assert(block.includes("Intimately"), "names Intimately");
  assert(block.includes("FP Movement"), "names FP Movement");
  // The disambiguation is the sub-line's category: denim vs lingerie vs activewear.
  assert(/denim/i.test(block), "We The Free denim fingerprint");
  assert(/lingerie|slip/i.test(block), "Intimately lingerie fingerprint");
  assert(/activewear|athleisure/i.test(block), "FP Movement activewear fingerprint");
  assert(block.includes("Black"), "named colorway present");
  assert(!/transcribe it VERBATIM/i.test(block), "no false decoder hint (FP has none)");
});

Deno.test("US-1729: FP women's size charts (tops/dresses + denim) are reachable", () => {
  const dresses = findSizingCharts("Free People", "dress");
  const alpha = dresses.find((c) => c.brand === "Free People" && c.garment === "Tops & dresses (alpha)");
  assert(alpha, "tops/dresses alpha chart present");
  assertEquals(alpha!.rows.find((r) => r.size === "XS")?.measurements.bust, "33"); // sourced

  const denim = findSizingCharts("free people", "jean");
  assert(denim.some((c) => c.brand === "Free People" && c.garment === "Denim (numeric waist)"), "denim numeric chart present");

  // "we the free" is a denim alias on the denim chart's brandMatch.
  const wtf = findSizingCharts("we the free", "denim");
  assert(wtf.some((c) => c.brand === "Free People"), "We The Free alias resolves the FP denim chart");
});
