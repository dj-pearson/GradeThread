// US-1571: the 'measurement' (MeasureCard) photo type — present in the
// vocabulary, labeled, non-listable, and NOT part of the required set.
import { describe, expect, it } from "vitest";
import {
  FLIPDESK_PHOTO_TYPES,
  isNonListablePhotoType,
  NON_LISTABLE_PHOTO_TYPES,
  PHOTO_TYPE_LABELS,
  REQUIRED_PHOTO_TYPES,
} from "@/lib/constants";

describe("measurement photo type (US-1571)", () => {
  it("is in the canonical vocabulary with a label", () => {
    expect(FLIPDESK_PHOTO_TYPES).toContain("measurement");
    expect(PHOTO_TYPE_LABELS["measurement"]).toMatch(/measurement card/i);
  });

  it("is non-listable (never ships to a marketplace) — like internal", () => {
    expect(NON_LISTABLE_PHOTO_TYPES).toContain("measurement");
    expect(isNonListablePhotoType("measurement")).toBe(true);
    expect(isNonListablePhotoType("internal")).toBe(true);
    // Tape-measure close-ups are a different concept and stay listable.
    expect(isNonListablePhotoType("measurement_chest")).toBe(false);
    expect(isNonListablePhotoType("front")).toBe(false);
  });

  it("does not join the required set (front + back stands)", () => {
    expect(REQUIRED_PHOTO_TYPES).not.toContain("measurement");
    expect([...REQUIRED_PHOTO_TYPES].sort()).toEqual(["back", "front"]);
  });
});
