// US-1733: verify the athleisure/activewear content (migration 00452) is correct
// + consumable by the engine. This group's through-line is that identity is read
// off the FABRIC PLATFORM, not a style code — so the confusable pairs are fabric
// siblings and the prompt block has to carry the fingerprint that separates them
// (Gymshark marl-vs-print, Beyond Yoga heather-vs-rib, Fabletics compression
// ladder). Under Armour is the ONLY brand here with a tag-printed decodable code,
// so it is the only one whose prompt block should carry the transcribe-the-code
// hint — the resolver-side decode itself is covered by brand-knowledge-golden.
//
// The size leg matters as much as brand/style here: this group holds the two
// costliest sizing traps in the KB (Sweaty Betty's UK labels, and Gymshark being
// a UK brand that does NOT use UK numerics), so both are asserted reachable.
//
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
const { canonicalizeBrand, isKnownBrand } = await import("../lib/brand-normalize.ts");
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

function style(
  styleName: string,
  productLine: string,
  visualFingerprint: string,
  fabricTech: string[],
): BrandStyleKnowledge {
  return {
    styleName,
    aliases: [],
    productLine,
    department: "Women",
    category: "legging",
    visualFingerprint,
    fabricTech,
    era: null,
    msrpBand: null,
    keywords: [],
  };
}

function pack(
  brand: string,
  key: string,
  styles: BrandStyleKnowledge[],
  decoders: BrandKnowledgePack["decoders"] = [],
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["activewear", "athleisure"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

// Packs shaped as the US-1711 resolver returns for the 00452-seeded rows,
// carrying the seeded fingerprints verbatim.
function seededGymsharkPack(): BrandKnowledgePack {
  return pack("Gymshark", "gymshark", [
    style(
      "Vital Seamless",
      "Vital",
      "MARL (heathered two-tone) seamless knit with a signature contouring DOT texture; ribbed waistband with internal power mesh. MARL + DOTS = Vital, never Adapt (~326gsm, medium weight).",
      ["seamless knit"],
    ),
    style(
      "Adapt Seamless",
      "Adapt",
      "PRINTED seamless knit — Camo (the original), Animal (abstract animal print, external bum scrunch), Fleck (speckled jacquard, no scrunch). PRINT + heft = Adapt (~420gsm, high compression, squat-proof). There is NO \"Adapt Marl\" — marl belongs to Vital.",
      ["seamless knit"],
    ),
  ]);
}

function seededBeyondYogaPack(): BrandKnowledgePack {
  return pack("Beyond Yoga", "beyondyoga", [
    style(
      "Spacedye",
      "Spacedye",
      "Yarn dyed BEFORE knitting => a subtle heathered/marled variation with visible tonal depth across the whole garment, NEVER a flat solid. If it photographs dead-flat, it is not Spacedye.",
      ["Spacedye"],
    ),
    style(
      "Heather Rib",
      "Heather Rib",
      "Separates from Spacedye by STRUCTURE, not color: a visible vertical RIB (raised wales running the garment length) vs Spacedye's smooth flat knit. BOTH are heathered, so heather alone does NOT separate them — look for the rib.",
      ["Heather Rib"],
    ),
  ]);
}

Deno.test("US-1733: the Gymshark prompt block carries the marl-vs-print disambiguation", () => {
  const block = brandPackPromptBlock(seededGymsharkPack());
  assert(block.includes("Vital Seamless"), "names Vital");
  assert(block.includes("Adapt Seamless"), "names Adapt");
  // The whole Vital-vs-Adapt call: marl texture vs a print.
  assert(/MARL/.test(block), "Vital marl fingerprint present");
  assert(/PRINTED|PRINT \+/.test(block), "Adapt print fingerprint present");
  // Gymshark has no tag-printed code — the block must not invite the AI to
  // transcribe one (its public identifier is a web SKU, not on the garment).
  assert(
    !/transcribe it VERBATIM/i.test(block),
    "no false decoder hint (Gymshark has none)",
  );
});

Deno.test("US-1733: the Beyond Yoga prompt block separates the two HEATHERED platforms by structure", () => {
  const block = brandPackPromptBlock(seededBeyondYogaPack());
  assert(block.includes("Spacedye"), "names Spacedye");
  assert(block.includes("Heather Rib"), "names Heather Rib");
  // The trap: both are heathered, so the rib — not the heather — is the tell.
  assert(/RIB/.test(block), "the rib structure is the stated separator");
  assert(/NEVER a flat solid/.test(block), "Spacedye is never flat");
  assert(
    !/transcribe it VERBATIM/i.test(block),
    "no false decoder hint (the BY SD/HR/IT code is web-side only, not tag-printed)",
  );
});

Deno.test("US-1733: Under Armour is the only brand in the group that invites a code transcription", () => {
  const ua = pack("Under Armour", "underarmour", [], [
    {
      decoderKind: "style_number",
      description:
        "Tag-printed 7-digit style number beneath the wash/care label, optionally prefixed STYLE and/or a season code (FW24 / SS25).",
      pattern: "^(?:STYLE\\s*)?(?:(?<season>FW|SS)(?<year>\\d{2})\\s*)?(?<style>\\d{7})$",
      extractionRules: {},
      examples: [],
    },
  ]);
  const block = brandPackPromptBlock(ua);
  assert(
    /transcribe it VERBATIM/i.test(block),
    "UA carries the decoder hint (it has a tag-printed style number)",
  );
});

Deno.test("US-1733: the new athleisure aliases canonicalize (were passthrough-only before)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("beyond yoga") into the prompt block and the eBay Brand aspect.
  assertEquals(canonicalizeBrand("beyond yoga"), "Beyond Yoga");
  assertEquals(canonicalizeBrand("BEYONDYOGA"), "Beyond Yoga");
  assertEquals(canonicalizeBrand("sweaty betty"), "Sweaty Betty");
  assertEquals(canonicalizeBrand("vuori"), "Vuori");
  assertEquals(canonicalizeBrand("fabletics"), "Fabletics");
  // isKnownBrand is what separates a curated entry from a passthrough.
  assert(isKnownBrand("beyond yoga"), "Beyond Yoga is now a curated entry");
  assert(isKnownBrand("sweaty betty"), "Sweaty Betty is now a curated entry");
});

Deno.test("US-1733: Sweaty Betty's chart carries the UK sizing trap — and the offset that BREAKS at XL", () => {
  const charts = findSizingCharts("Sweaty Betty", "legging");
  const women = charts.find((c) => c.brand === "Sweaty Betty" && c.department === "Women");
  assert(women, "women's bottoms chart present");

  // UK 12 = US 8, the costliest error on the brand (a two-size overstatement).
  const uk12 = women!.rows.find((r) => r.size.startsWith("UK 12"));
  assertEquals(uk12?.measurements.us, "8");
  assertEquals(uk12?.measurements.waist, "29");

  // The trap: the -4 offset does NOT hold above UK 14 — UK 16-18 collapses to
  // US 12 (not US 12-14 via a blind subtract-4 on 16).
  const xl = women!.rows.find((r) => r.size.startsWith("UK 16-18"));
  assertEquals(xl?.measurements.us, "12");
  assert(/BREAKS|MINUS 4/.test(women!.note ?? ""), "note documents the offset + its break");
});

Deno.test("US-1733: Gymshark is a UK brand with NO UK-numeric trap — alpha sizes only", () => {
  const charts = findSizingCharts("gymshark", "legging");
  const women = charts.find((c) => c.brand === "Gymshark" && c.department === "Women");
  assert(women, "women's bottoms chart present");
  // Alpha, not UK numerics — the counterintuitive fact vs its UK sibling above.
  assert(
    women!.rows.every((r) => !/^UK /.test(r.size)),
    "no UK numeric labels on Gymshark",
  );
  assertEquals(women!.rows.find((r) => r.size === "M")?.measurements.waist, "30");
  assert(/INTERNATIONAL/i.test(women!.note ?? ""), "note states international alpha sizing");
});

Deno.test("US-1733: the group's charts are reachable per brand + are BODY measurements", () => {
  // Every brand in the group resolves a chart for its highest-volume category.
  const cases: Array<[string, string, string]> = [
    ["Under Armour", "legging", "Women"],
    ["Under Armour", "tee", "Men"],
    ["Vuori", "short", "Men"],
    ["Vuori", "legging", "Women"],
    ["Fabletics", "legging", "Women"],
    ["Beyond Yoga", "legging", "Women"],
  ];
  for (const [brand, category, department] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand && c.department === department),
      `${brand} ${department} chart reachable for "${category}"`,
    );
  }

  // The #1 way to misgrade a size in this category is comparing a BODY chart to
  // a flat-lay tape (a compression legging measures far smaller flat than its
  // listed hip), so every chart in the group must say which basis it is.
  const group = ["Under Armour", "Vuori", "Gymshark", "Fabletics", "Beyond Yoga", "Sweaty Betty"];
  for (const brand of group) {
    const charts = findSizingCharts(brand, "legging").concat(findSizingCharts(brand, "top"));
    const mine = charts.filter((c) => c.brand === brand);
    assert(mine.length > 0, `${brand} has at least one chart`);
    for (const c of mine) {
      assert(/BODY/i.test(c.note ?? ""), `${brand} ${c.garment} note states the BODY basis`);
    }
  }
});
