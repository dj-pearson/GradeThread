import { describe, expect, it } from "vitest";
import {
  buildListerPayload,
  isListerPlatform,
  revisePriceFor,
  LISTER_EXTENSION_PLATFORMS,
} from "../lister-extension";
import type { PlatformKitVariant } from "@/hooks/use-autolister";
import type { ExportablePhoto } from "@/lib/photo-export";

const variant: PlatformKitVariant = {
  platform: "poshmark",
  title: "Vintage Levi's 501 Denim Jacket",
  description: "Classic trucker jacket in great shape.",
  condition: { value: "EUC", label: "EUC (Excellent Used Condition)" },
  category: "Women > Jackets & Coats > Jean Jackets",
  brand: "Levi's",
  color: "Blue",
  size: "M",
  price: 48,
  tags: ["#vintage", "#denim", "#levis"],
  confidence: 0.9,
  validation: { platform: "poshmark", ok: true, issues: [] },
};

const photos: ExportablePhoto[] = [
  { id: "a", photo_url: "https://cdn/x/a.jpg", photo_type: "front", sort_order: 1 },
  { id: "b", photo_url: "https://cdn/x/b.jpg", photo_type: "back", sort_order: 2 },
];

describe("isListerPlatform", () => {
  it("accepts only the no-API extension platforms", () => {
    expect(isListerPlatform("poshmark")).toBe(true);
    expect(isListerPlatform("mercari")).toBe(true);
    expect(isListerPlatform("grailed")).toBe(true);
    // eBay/Shopify push via API, Depop has its own partner API path.
    expect(isListerPlatform("ebay")).toBe(false);
    expect(isListerPlatform("shopify")).toBe(false);
    expect(isListerPlatform("depop")).toBe(false);
  });

  it("LISTER_EXTENSION_PLATFORMS is exactly the no-API channels", () => {
    // US-2479/US-2480 added Vinted and Facebook. Pinned as a list rather than a
    // count so adding a channel is a deliberate edit here — this array decides
    // which platforms the Listing Kit will hand to the extension at all, and a
    // platform that is advertised as tier `extension` but absent from it fails
    // with "invalid payload", which reads to the seller as their own mistake.
    expect([...LISTER_EXTENSION_PLATFORMS]).toEqual([
      "poshmark",
      "mercari",
      "grailed",
      "vinted",
      "facebook",
    ]);
  });
});

describe("buildListerPayload", () => {
  it("maps a generated variant into the extension payload", () => {
    const p = buildListerPayload({
      platform: "poshmark",
      itemId: "item-123",
      variant,
      photos,
      primaryId: "a",
    });
    expect(p.platform).toBe("poshmark");
    expect(p.platformLabel).toBe("Poshmark");
    expect(p.itemId).toBe("item-123");
    expect(p.newListingUrl).toContain("poshmark.com");
    expect(p.title).toBe(variant.title);
    expect(p.description).toBe(variant.description);
    expect(p.price).toBe("48");
    expect(p.condition).toBe("EUC (Excellent Used Condition)");
    expect(p.tags).toEqual(["#vintage", "#denim", "#levis"]);
    expect(p.photoUrls).toContain("https://cdn/x/a.jpg");
  });

  it("caps photoUrls to the platform's max and leads with the cover", () => {
    const many: ExportablePhoto[] = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      photo_url: `https://cdn/x/p${i}.jpg`,
      photo_type: "detail",
      sort_order: i,
    }));
    const p = buildListerPayload({
      platform: "poshmark", // maxPhotos 16
      itemId: "item-9",
      variant,
      photos: many,
      primaryId: "p5",
    });
    expect(p.maxPhotos).toBe(16);
    expect(p.photoUrls).toHaveLength(16);
    expect(p.photoUrls[0]).toBe("https://cdn/x/p5.jpg"); // cover first
  });

  it("emits empty strings (not undefined) for absent optional fields", () => {
    const bare: PlatformKitVariant = {
      ...variant,
      brand: null,
      color: null,
      size: null,
      condition: null,
      price: 0,
    };
    const p = buildListerPayload({
      platform: "grailed",
      itemId: "i",
      variant: bare,
      photos: [],
      primaryId: null,
    });
    expect(p.brand).toBe("");
    expect(p.color).toBe("");
    expect(p.size).toBe("");
    expect(p.condition).toBe("");
    expect(p.price).toBe("");
    expect(p.photoUrls).toEqual([]);
  });
});

// ── US-2739: the browser payload crosses the same units boundary ───────────
//
// The Listing Kit steps the price for the row it shows the seller, so this is a
// no-op on that path BY DESIGN. It is here because buildListerPayload is
// exported and the server builds the same payload shape for anything queued
// from a phone; before US-2739 only the kit knew Poshmark prices in whole
// dollars, and the two paths disagreed about what an item costs.
describe("buildListerPayload sends the units the marketplace accepts (US-2739)", () => {
  function priceFor(platform: "poshmark" | "vinted" | "mercari" | "grailed", price: number) {
    return buildListerPayload({
      platform,
      itemId: "i",
      variant: { ...variant, platform, price },
      photos,
      primaryId: "a",
    }).price;
  }

  it("a whole-dollar marketplace gets digits, with no decimal point", () => {
    // Poshmark's listing-price input is inputmode="numeric" pattern="[0-9]*".
    expect(priceFor("poshmark", 32.49)).toBe("32");
    expect(priceFor("vinted", 32.49)).toBe("32");
  });

  it("rounds to NEAREST, because flooring takes money off the seller", () => {
    expect(priceFor("poshmark", 32.51)).toBe("33");
    expect(priceFor("poshmark", 74.5)).toBe("75");
  });

  it("never below one step, and a price nobody set stays unset", () => {
    expect(priceFor("poshmark", 0.4)).toBe("1");
    expect(priceFor("poshmark", 0)).toBe("");
  });

  it("a marketplace with no step keeps its exact cents", () => {
    expect(priceFor("mercari", 32.49)).toBe("32.49");
    expect(priceFor("grailed", 32.49)).toBe("32.49");
    // Built from cents, so a float tail can never reach a price field.
    expect(priceFor("mercari", 0.1 + 0.2)).toBe("0.30");
  });
});

// A revise carries the price as a NUMBER (the extension types String(price) into
// the marketplace's editor), and it comes off listings.listing_price, which
// repricing automation writes as 32.49. Same boundary, different shape.
describe("a revise sends the price in the marketplace's units (US-2739)", () => {
  it("steps a whole-dollar marketplace and leaves the rest exact", () => {
    expect(revisePriceFor("poshmark", 32.49)).toBe(32);
    expect(revisePriceFor("poshmark", 32.51)).toBe(33);
    expect(revisePriceFor("vinted", 0.4)).toBe(1);
    expect(revisePriceFor("mercari", 32.49)).toBe(32.49);
    expect(revisePriceFor("grailed", 32.49)).toBe(32.49);
  });

  it("no price is null, not a zero the editor would accept", () => {
    expect(revisePriceFor("poshmark", null)).toBeNull();
    expect(revisePriceFor("poshmark", undefined)).toBeNull();
    expect(revisePriceFor("poshmark", Number.NaN)).toBeNull();
  });
});

