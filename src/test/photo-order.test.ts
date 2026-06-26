// Canonical default photo order (Front → Back → Tag → Detail …) for FlipDesk
// listings. The order drives the eBay cover/main image and the listing's photo
// sequence, so it must be deterministic regardless of upload order.

import { describe, it, expect } from "vitest";
import {
  photoTypeRank,
  nextUploadSortOrder,
  canonicalPhotoSort,
} from "@/lib/photo-order";

describe("photoTypeRank", () => {
  it("ranks front before back before tag before detail", () => {
    expect(photoTypeRank("front")).toBeLessThan(photoTypeRank("back"));
    expect(photoTypeRank("back")).toBeLessThan(photoTypeRank("tag"));
    expect(photoTypeRank("tag")).toBeLessThan(photoTypeRank("detail"));
  });

  it("ranks detail before measurements before defects", () => {
    // Canonical gallery order: Front → Back → Tag → Detail → measurements →
    // defects → extras.
    expect(photoTypeRank("detail")).toBeLessThan(
      photoTypeRank("measurement_chest"),
    );
    expect(photoTypeRank("measurement_inseam")).toBeLessThan(
      photoTypeRank("defect"),
    );
    expect(photoTypeRank("defect")).toBeLessThan(photoTypeRank("tag_2"));
  });

  it("sorts unknown types last", () => {
    expect(photoTypeRank("front")).toBeLessThan(
      photoTypeRank("not_a_real_type"),
    );
  });
});

describe("nextUploadSortOrder", () => {
  it("yields the canonical order even when uploaded back-to-front", () => {
    // Simulate uploading back, then front, then detail, then tag.
    const photos: { photo_type: string; sort_order: number }[] = [];
    for (const t of ["back", "front", "detail", "tag"]) {
      photos.push({ photo_type: t, sort_order: nextUploadSortOrder(photos, t) });
    }
    const ordered = [...photos].sort((a, b) => a.sort_order - b.sort_order);
    expect(ordered.map((p) => p.photo_type)).toEqual([
      "front",
      "back",
      "tag",
      "detail",
    ]);
  });

  it("stacks multiple photos of the same type after one another", () => {
    const photos = [{ photo_type: "detail", sort_order: 0 }];
    const second = nextUploadSortOrder(photos, "detail");
    expect(second).toBeGreaterThan(0);
    // A subsequent detail keeps climbing within the same type band.
    photos.push({ photo_type: "detail", sort_order: second });
    expect(nextUploadSortOrder(photos, "detail")).toBeGreaterThan(second);
  });

  it("places a new type at its canonical band, not merely at the end", () => {
    // Front already present; a freshly added tag must sort AFTER front but
    // its band sits below where a later detail would land.
    const photos = [{ photo_type: "front", sort_order: 0 }];
    const tagOrder = nextUploadSortOrder(photos, "tag");
    photos.push({ photo_type: "tag", sort_order: tagOrder });
    const detailOrder = nextUploadSortOrder(photos, "detail");
    expect(tagOrder).toBeGreaterThan(0);
    expect(detailOrder).toBeGreaterThan(tagOrder);
  });
});

describe("canonicalPhotoSort", () => {
  it("orders by type rank, preserving sort_order within a type", () => {
    const photos = [
      { id: "d1", photo_type: "detail", sort_order: 5 },
      { id: "f1", photo_type: "front", sort_order: 9 },
      { id: "d2", photo_type: "detail", sort_order: 2 },
      { id: "b1", photo_type: "back", sort_order: 1 },
    ];
    expect(canonicalPhotoSort(photos).map((p) => p.id)).toEqual([
      "f1",
      "b1",
      "d2",
      "d1",
    ]);
  });
});
