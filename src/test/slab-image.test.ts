// US-766: the Digital-Slab listing-image URL derivation (src/lib/slab-image.ts).
//
// The slab URL must be derived from the item's PUBLIC certificate_url by
// rewriting the first "/cert/" segment to "/slab/cert/" and appending the
// format — never by hard-coding an origin. The same logic is mirrored in the
// edge service's flipdesk-ebay.ts (slabImageUrlForItem), so these cases double
// as a contract for both.

import { describe, it, expect } from "vitest";
import { slabImageUrl, SLAB_MODE_LABELS } from "@/lib/slab-image";

describe("slabImageUrl", () => {
  it("rewrites /cert/ to /slab/cert/ and appends the square format by default", () => {
    expect(slabImageUrl("https://gradethread.com/cert/abc-123")).toBe(
      "https://gradethread.com/slab/cert/abc-123?format=square",
    );
  });

  it("honors an explicit format", () => {
    expect(slabImageUrl("https://gradethread.com/cert/abc-123", "portrait")).toBe(
      "https://gradethread.com/slab/cert/abc-123?format=portrait",
    );
  });

  it("preserves an existing query string with & instead of ?", () => {
    expect(slabImageUrl("https://gradethread.com/cert/abc-123?s=qr")).toBe(
      "https://gradethread.com/slab/cert/abc-123?s=qr&format=square",
    );
  });

  it("returns null when there is no certificate (uncertified item)", () => {
    expect(slabImageUrl(null)).toBeNull();
    expect(slabImageUrl(undefined)).toBeNull();
    expect(slabImageUrl("")).toBeNull();
  });

  it("returns null for a URL that is not a /cert/ link", () => {
    expect(slabImageUrl("https://gradethread.com/dashboard")).toBeNull();
  });

  it("labels every slab mode", () => {
    expect(SLAB_MODE_LABELS.off).toBeTruthy();
    expect(SLAB_MODE_LABELS.hero).toBeTruthy();
    expect(SLAB_MODE_LABELS.extra).toBeTruthy();
  });
});
