import { describe, expect, it } from "vitest";
import {
  buildListerPayload,
  isListerPlatform,
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
