// What a cross-post to a non-eBay marketplace is allowed to carry.
//
// Owner decision, 2026-09-07: neither the MeasureCard nor anything derived from
// it travels to a browser-extension channel. Both paths out of the SPA — the
// extension send (buildListerPayload) and the manual zip (exportPhotosForPlatform)
// — order their photos through orderedCappedPhotos, so this is the one gate.
//
// The edge has its own copy in extension-queue.ts (the phone-queued path shares
// no module graph with the SPA); extension-queue-payload_test.ts holds the
// matching cases.

import { describe, it, expect } from "vitest";
import { orderedCappedPhotos, type ExportablePhoto } from "@/lib/photo-export";
import { isExtensionIneligiblePhotoType } from "@/lib/constants";

function photo(over: Partial<ExportablePhoto> & { id: string }): ExportablePhoto {
  return {
    photo_url: `https://ex.test/${over.id}.jpg`,
    photo_type: "detail",
    photo_role: null,
    sort_order: 0,
    ...over,
  };
}

describe("isExtensionIneligiblePhotoType", () => {
  it("bars the MeasureCard frame and its generated render", () => {
    expect(isExtensionIneligiblePhotoType("measurement", null)).toBe(true);
    expect(isExtensionIneligiblePhotoType("measurement_overlay", null)).toBe(true);
    expect(isExtensionIneligiblePhotoType("internal", null)).toBe(true);
  });

  it("lets a tape close-up through", () => {
    // US-2462: 'measurement' WITH a role is a shot the seller published on
    // purpose, not the branded card.
    expect(isExtensionIneligiblePhotoType("measurement", "measurement_chest")).toBe(false);
  });

  it("lets ordinary listing photos through, typed or not", () => {
    expect(isExtensionIneligiblePhotoType("front", null)).toBe(false);
    expect(isExtensionIneligiblePhotoType(null, null)).toBe(false);
    expect(isExtensionIneligiblePhotoType(undefined, undefined)).toBe(false);
  });
});

describe("orderedCappedPhotos", () => {
  it("drops the MeasureCard and the overlay from a cross-post", () => {
    const photos = [
      photo({ id: "front", photo_type: "front", sort_order: 0 }),
      photo({ id: "card", photo_type: "measurement", sort_order: 1 }),
      photo({ id: "overlay", photo_type: "measurement_overlay", sort_order: 2 }),
      photo({ id: "back", photo_type: "back", sort_order: 3 }),
    ];
    expect(orderedCappedPhotos(photos, null, "poshmark").map((p) => p.id)).toEqual([
      "front",
      "back",
    ]);
  });

  it("does not spend a platform slot on a photo it will not send", () => {
    // Filtered BEFORE the cap. Counting the card against Vinted's limit would
    // cost the seller a real listing image.
    const photos = [
      photo({ id: "card", photo_type: "measurement", sort_order: 0 }),
      photo({ id: "front", photo_type: "front", sort_order: 1 }),
      photo({ id: "back", photo_type: "back", sort_order: 2 }),
    ];
    const out = orderedCappedPhotos(photos, null, "poshmark");
    expect(out.map((p) => p.id)).toContain("front");
    expect(out.map((p) => p.id)).toContain("back");
  });

  it("still puts the seller's cover first", () => {
    const photos = [
      photo({ id: "front", photo_type: "front", sort_order: 0 }),
      photo({ id: "card", photo_type: "measurement", sort_order: 1 }),
      photo({ id: "back", photo_type: "back", sort_order: 2 }),
    ];
    expect(orderedCappedPhotos(photos, "back", "poshmark").map((p) => p.id)).toEqual([
      "back",
      "front",
    ]);
  });

  it("keeps a tape close-up", () => {
    const photos = [
      photo({ id: "front", photo_type: "front", sort_order: 0 }),
      photo({
        id: "chest",
        photo_type: "measurement",
        photo_role: "measurement_chest",
        sort_order: 1,
      }),
    ];
    expect(orderedCappedPhotos(photos, null, "poshmark").map((p) => p.id)).toEqual([
      "front",
      "chest",
    ]);
  });
});
