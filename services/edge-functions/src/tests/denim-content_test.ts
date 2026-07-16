// US-1735: verify the premium & vintage denim content (migration 00454) is
// correct + consumable by the engine.
//
// This group splits in half and the two halves have OPPOSITE rules, which is what
// the assertions below are really protecting:
//
//   * VINTAGE (Wrangler / Lee) — value comes from the TAG ERA, not the model. The
//     same model number spans the decades, so the era tell (Blue Bell / UNION
//     MADE) is what separates a collectible from an ordinary modern pair. And the
//     sizing runs SMALL against the tag.
//   * PREMIUM (7FAM / True Religion / AG / Citizens) — value comes from the FIT
//     NAME on the tag; era is near-worthless. And the sizing runs LARGE against
//     the tag.
//
// Wrangler + True Religion are the only two brands here with a decodable code, so
// they are the only ones whose block should carry the transcribe-the-code hint —
// the resolver-side decode itself is covered by brand-knowledge-golden.
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
  fabricTech: string[] = [],
): BrandStyleKnowledge {
  return {
    styleName,
    aliases: [],
    productLine,
    department: "Unisex",
    category: "jean",
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
    categoryFocus: ["denim"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1735: the Wrangler block carries the era-not-the-model call", () => {
  // Packs shaped as the US-1711 resolver returns for the 00454-seeded rows,
  // carrying the seeded fingerprints verbatim.
  const block = brandPackPromptBlock(
    pack("Wrangler", "wrangler", [
      style(
        "13MWZ Cowboy Cut",
        "Cowboy Cut",
        "THE Wrangler jean: the original Cowboy Cut, a rigid 13oz straight leg with the broken-W pockets. The model number decodes literally — 13 = the 13-ounce denim, MWZ = Men's With Zipper. CRITICAL: the model number does NOT date the jean, because a modern 13MWZ carries the same number as a 1970s one. The TAG decides the tier — a Blue Bell tag is pre-1986 and worth multiples of a current pair that looks nearly identical.",
        ["13oz rigid denim"],
      ),
      style(
        "936DEN Slim Fit",
        "Cowboy Cut",
        "The SLIM-fit Cowboy Cut — same broken-W pockets and same family as the 13MWZ, cut narrower through the seat and thigh. vs 13MWZ: the silhouette is the only difference and it is easy to misread on a flat-lay, so read the MODEL NUMBER off the tag rather than judging the leg by eye.",
      ),
    ]),
  );
  assert(block.includes("13MWZ"), "names the 13MWZ");
  assert(block.includes("936DEN"), "names the 936DEN");
  // The whole vintage-Wrangler call: the number is era-blind, so the TAG decides
  // the value. Getting this wrong is the group's most expensive mistake.
  assert(/does NOT date the jean/.test(block), "the number is stated era-blind");
  assert(/Blue Bell/.test(block), "the Blue Bell dating tell reaches the block");
  // And the two Cowboy Cut fits are separated by the number, not by the leg.
  assert(/broken-W/.test(block), "the broken-W pocket stitch reaches the block");
});

Deno.test("US-1735: the Lee block separates the Storm Rider by its LINING", () => {
  const block = brandPackPromptBlock(
    pack("Lee", "lee", [
      style(
        "Storm Rider",
        "Storm Rider",
        "THE Lee collectible: the blanket-lined denim jacket — a 101J shell with a plaid wool-look BLANKET LINING and a corduroy collar. vs a plain 101J: the 101J is unlined with a plain denim collar, and it is worth materially less — so open the jacket and check the lining before titling it a Storm Rider.",
        ["blanket lining", "corduroy"],
      ),
      style(
        "101J Denim Jacket",
        "101",
        "The unlined western denim jacket — the Storm Rider's plain sibling, with a denim collar and no blanket lining. The lining is the separator and it is the difference between two very different prices.",
      ),
    ]),
  );
  assert(block.includes("Storm Rider"), "names the Storm Rider");
  assert(block.includes("101J"), "names the plain 101J");
  // The money call on Lee's best piece — and it is readable in a photo.
  assert(/BLANKET LINING/.test(block), "the blanket lining is the stated tell");
  assert(/no blanket lining/.test(block), "the plain 101J is explicitly unlined");
});

Deno.test("US-1735: the True Religion block carries the STITCH WEIGHT price lever", () => {
  const block = brandPackPromptBlock(
    pack("True Religion", "truereligion", [
      style(
        "Ricky",
        "Ricky",
        "The men's relaxed straight and True Religion's highest-VOLUME resale item. THE CALL ON THIS JEAN IS THE STITCH WEIGHT, not the fit: a Ricky Super T (thickest contrast topstitching) comps well above a standard-stitch Ricky of the same size and wash.",
        ["heavy contrast topstitch"],
      ),
      style(
        "Super T",
        "Stitch grade",
        "NOT a fit — a STITCH GRADE that any fit can carry. Super T is the thickest contrast topstitching in the line; Big T is the thick-but-lesser grade. It must be read INDEPENDENTLY of the fit name and both must appear in the title (\"Ricky Super T\").",
        ["heavy contrast topstitch"],
      ),
    ]),
  );
  assert(/STITCH WEIGHT/.test(block), "the stitch weight is named as the call");
  assert(/Super T/.test(block), "Super T reaches the block");
  assert(/Big T/.test(block), "Big T reaches the block");
  // The subtle part: the grade is orthogonal to the fit, so a model that reads
  // only the fit name silently undersells the jean.
  assert(/NOT a fit/.test(block), "the stitch grade is stated to be orthogonal to the fit");
});

Deno.test("US-1735: the AG block warns that the AG-ed wash is not wear", () => {
  const block = brandPackPromptBlock(
    pack("AG Jeans", "agjeans", [
      style(
        "Graduate",
        "Graduate",
        "The men's tailored straight and AG's highest-VOLUME men's resale item. vs Tellis (slim) and Everett (slim straight): the three men's blocks sit close together and AG has NO signature pocket stitch to fall back on, so the tag name is the identification. Whatever whiskering and fading it carries is almost certainly the AG-ed finish, not wear.",
        ["AG-ed wash"],
      ),
    ]),
  );
  // The condition trap: AG sells a distressed finish, and grading that finish as
  // damage marks down a garment that is in the condition it shipped in.
  assert(/AG-ed/.test(block), "the AG-ed wash is named");
  assert(/not wear/.test(block), "the wash is explicitly distinguished from wear");
  // And the honest admission that an unlabelled AG is hard to place.
  assert(/NO signature pocket stitch/.test(block), "the missing pocket tell is stated");
});

Deno.test("US-1735: only Wrangler + True Religion invite a code transcription", () => {
  const decodable: Array<[string, string, BrandKnowledgePack["decoders"][number]]> = [
    ["Wrangler", "wrangler", {
      decoderKind: "style_number",
      description:
        'Wrangler tag-printed model number: the MW family — e.g. "13MWZ", "47MWZ", "11MJ" — or the DEN slim-fit form, e.g. "936DEN".',
      pattern: "^(?:(?<style>\\d{2,3}(?:MWZ|MJ|MW))|(?<slim>\\d{3}DEN))$",
      extractionRules: {},
      examples: [],
    }],
    ["True Religion", "truereligion", {
      decoderKind: "style_name",
      description:
        'True Religion MODEL + stitch-weight SUFFIX printed on the tag (Super T / Big T) — e.g. "Ricky Super T".',
      pattern: "^(?<style>(?:Ricky|Joey)\\s+(?:Super\\s*T|Big\\s*T))$",
      extractionRules: {},
      examples: [],
    }],
  ];
  for (const [brand, key, decoder] of decodable) {
    const block = brandPackPromptBlock(pack(brand, key, [], [decoder]));
    assert(
      /transcribe it VERBATIM/i.test(block),
      `${brand} carries the decoder hint (its code is garment-printed)`,
    );
  }

  // The other four are decoder-less by design: they print a fit NAME, not a code.
  // Lee is the pointed one — the 101 LOOKS like a code and deliberately is not
  // treated as one, because "101" is an ordinary number.
  for (const [brand, key] of [
    ["Lee", "lee"],
    ["7 For All Mankind", "7forallmankind"],
    ["AG Jeans", "agjeans"],
    ["Citizens of Humanity", "citizensofhumanity"],
  ]) {
    const b = brandPackPromptBlock(pack(brand, key, [
      style("X", "X", "a fingerprint"),
    ]));
    assert(
      !/transcribe it VERBATIM/i.test(b),
      `${brand} must not invite a code transcription (it has no decodable code)`,
    );
  }
});

Deno.test("US-1735: the new denim aliases canonicalize (were passthrough-only before)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("true religion") into the prompt block and the eBay Brand aspect.
  assertEquals(canonicalizeBrand("true religion"), "True Religion");
  assertEquals(canonicalizeBrand("TRUERELIGION"), "True Religion");
  assertEquals(canonicalizeBrand("7 for all mankind"), "7 For All Mankind");
  assertEquals(canonicalizeBrand("seven for all mankind"), "7 For All Mankind");
  assertEquals(canonicalizeBrand("7FAM"), "7 For All Mankind");
  assertEquals(canonicalizeBrand("citizens of humanity"), "Citizens of Humanity");
  assert(isKnownBrand("true religion"), "True Religion is now a curated entry");
  assert(isKnownBrand("citizens of humanity"), "Citizens is now a curated entry");

  // AG canonicalizes to "AG Jeans", NOT "AG" — the two-letter form is kept as an
  // exact-match alias only, because a canonical "AG" would fire inside other
  // brands' text. This is what makes the bare seller input recoverable WITHOUT
  // creating the substring hazard.
  assertEquals(canonicalizeBrand("AG"), "AG Jeans");
  assertEquals(canonicalizeBrand("ag jeans"), "AG Jeans");
  assertEquals(canonicalizeBrand("Adriano Goldschmied"), "AG Jeans");

  // AGOLDE is a Citizens of Humanity label, NOT an AG Jeans one despite the name.
  assertEquals(canonicalizeBrand("AGOLDE"), "AGOLDE");

  // The two vintage brands were already curated; the Blue Bell mark is new and
  // resolves to Wrangler, since a Blue Bell tag IS a Wrangler tag.
  assertEquals(canonicalizeBrand("wrangler"), "Wrangler");
  assertEquals(canonicalizeBrand("Blue Bell"), "Wrangler");
  assertEquals(canonicalizeBrand("H.D. Lee"), "Lee");

  // A bare "citizens" must NOT rebrand — it is an ordinary word, so it stays a
  // passthrough rather than minting a brand from a stray tag token (the same rule
  // that keeps "bean" off L.L.Bean).
  assert(!isKnownBrand("citizens"), "a bare 'citizens' is not a curated entry");
  assertEquals(canonicalizeBrand("citizens"), "citizens");
});

Deno.test("US-1735: a bare 'ag' must never hand Patagonia an AG denim chart", () => {
  // THE trap this group has to defend against. findSizingCharts matches brandMatch
  // by SUBSTRING, and "patagonia" CONTAINS "ag" — so a bare "ag" entry would give
  // every Patagonia garment AG Jeans' denim charts. Guard the invariant directly
  // rather than trusting a comment to survive.
  assert("patagonia".includes("ag"), "premise: 'patagonia' really does contain 'ag'");
  const patagonia = findSizingCharts("Patagonia", "jacket");
  assert(
    !patagonia.some((c) => c.brand === "AG Jeans"),
    "Patagonia must not resolve an AG Jeans chart",
  );
  // And Patagonia still reaches its own (shared) outerwear chart — the guard must
  // not have stranded it.
  assert(
    patagonia.some((c) => c.brand === "The North Face / Patagonia (outerwear)"),
    "Patagonia still reaches the shared outerwear chart",
  );

  // AG is reachable via the CANONICAL brand string, which is the whole reason the
  // canonical is "AG Jeans" rather than "AG".
  const ag = findSizingCharts(canonicalizeBrand("AG"), "jean");
  assert(
    ag.some((c) => c.brand === "AG Jeans" && c.department === "Men"),
    "AG Jeans resolves its own chart via the canonical brand",
  );
});

Deno.test("US-1735: the group's charts are reachable per brand", () => {
  const cases: Array<[string, string, string]> = [
    ["Wrangler", "jean", "Men"],
    ["Wrangler", "denim", "Women"],
    ["Wrangler", "denim jacket", "Unisex"],
    ["Lee", "jean", "Men"],
    ["Lee", "denim", "Women"],
    ["Lee", "denim jacket", "Unisex"],
    ["7 For All Mankind", "jean", "Women"],
    ["7 For All Mankind", "jean", "Men"],
    ["True Religion", "jean", "Men"],
    ["True Religion", "jean", "Women"],
    ["AG Jeans", "jean", "Men"],
    ["AG Jeans", "jean", "Women"],
    ["Citizens of Humanity", "jean", "Women"],
    ["Citizens of Humanity", "jean", "Men"],
  ];
  for (const [brand, category, department] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand && c.department === department),
      `${brand} ${department} chart reachable for "${category}"`,
    );
  }

  // Levi's and Madewell already carry their own denim charts from 00389 and must
  // not have been disturbed — none of the six new brands may bleed onto them.
  for (const brand of ["Levi's", "Madewell"]) {
    const charts = findSizingCharts(brand, "jean");
    assert(charts.length > 0, `${brand} still resolves a denim chart`);
    assert(
      charts.every((c) => c.brand === brand),
      `${brand} resolves only its own charts`,
    );
  }
});

Deno.test("US-1735: every denim chart states its basis and says to measure", () => {
  // Denim is THE exception in this epic: the label is a MEASUREMENT, not an alpha
  // letter mapped onto a body. So the jeans charts are NOMINAL WAIST charts, while
  // the two alpha-sized denim JACKET charts are genuine BODY charts. Each note has
  // to say which it is, or the model has no way to know how to read it.
  const jeanBrands = [
    "Wrangler",
    "Lee",
    "7 For All Mankind",
    "True Religion",
    "AG Jeans",
    "Citizens of Humanity",
  ];
  for (const brand of jeanBrands) {
    const charts = findSizingCharts(brand, "jean").filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has at least one jeans chart`);
    for (const c of charts) {
      assert(
        /NOMINAL WAIST/.test(c.note ?? ""),
        `${brand} ${c.garment} note states the NOMINAL WAIST basis`,
      );
      // The only defensible number on a used pair.
      assert(
        /flat waistband/i.test(c.note ?? ""),
        `${brand} ${c.garment} note tells the seller to measure the flat waistband`,
      );
    }
  }

  // The jackets are the exception-to-the-exception: alpha-sized, so BODY charts.
  for (const brand of ["Wrangler", "Lee"]) {
    const jacket = findSizingCharts(brand, "denim jacket")
      .find((c) => c.brand === brand && c.department === "Unisex");
    assert(jacket, `${brand} has a denim jacket chart`);
    assert(
      /BODY measurement/.test(jacket!.note ?? ""),
      `${brand} jacket note states the BODY basis (the jackets are alpha-sized)`,
    );
  }
});

Deno.test("US-1735: the vintage and premium halves warn in OPPOSITE directions", () => {
  // The group's signature trap. Both halves are denim and both are labeled with a
  // waist number, but the tag lies in opposite directions — so one blanket "denim
  // runs X" rule would be wrong for half the pack.
  for (const brand of ["Wrangler", "Lee"]) {
    const chart = findSizingCharts(brand, "jean")
      .find((c) => c.brand === brand && c.department === "Men");
    assert(chart, `${brand} men's chart present`);
    assert(
      /runs SMALL against its tag/.test(chart!.note ?? ""),
      `${brand} (vintage) warns that it runs SMALL against the tag`,
    );
  }

  for (const brand of ["7 For All Mankind", "True Religion", "AG Jeans", "Citizens of Humanity"]) {
    const charts = findSizingCharts(brand, "jean").filter((c) => c.brand === brand);
    assert(
      charts.some((c) => /PREMIUM/.test(c.note ?? "")),
      `${brand} (premium) carries the runs-large premium caveat`,
    );
  }

  // Spelled out on the 7FAM chart, which is where the contrast is stated.
  const sevens = findSizingCharts("7 For All Mankind", "jean")
    .find((c) => c.department === "Women");
  assert(/runs LARGE against its tag/.test(sevens!.note ?? ""), "premium runs LARGE");
  assert(
    /OPPOSITE to the vintage brands/.test(sevens!.note ?? ""),
    "the note names the contrast with the vintage half of its own group",
  );
});
