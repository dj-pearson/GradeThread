import { describe, expect, it } from "vitest";
import {
  autoGroupPhotos,
  type GroupablePhoto,
  hammingHex,
  VISUAL_MERGE_MAX_DISTANCE,
  visualPairs,
} from "./autolister-grouping";

function p(id: string, iso: string | null, phash = "0000000000000000"): GroupablePhoto {
  return { id, capturedAt: iso ? new Date(iso) : null, phash };
}

describe("hammingHex", () => {
  it("is 0 for identical hashes", () => {
    expect(hammingHex("0000000000000000", "0000000000000000")).toBe(0);
  });
  it("counts single-bit differences", () => {
    expect(hammingHex("0000000000000000", "0000000000000001")).toBe(1);
    expect(hammingHex("0000000000000000", "0000000000000003")).toBe(2);
  });
  it("is max (64) for a missing/malformed hash", () => {
    expect(hammingHex("", "0000000000000000")).toBe(64);
    expect(hammingHex("zzzz", "0000000000000000")).toBe(64);
  });
});

describe("autoGroupPhotos", () => {
  it("splits capture-time bursts into separate item groups", () => {
    // Two bursts ~60s apart (> the 30s default gap), distinct phashes.
    const photos = [
      p("a1", "2024-01-01T10:00:00Z", "0000000000000000"),
      p("a2", "2024-01-01T10:00:05Z", "ffff000000000000"),
      p("b1", "2024-01-01T10:01:00Z", "0000ffff00000000"),
      p("b2", "2024-01-01T10:01:04Z", "00000000ffff0000"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(2);
    expect(new Set(groups[0]!.photoIds)).toEqual(new Set(["a1", "a2"]));
    expect(new Set(groups[1]!.photoIds)).toEqual(new Set(["b1", "b2"]));
    // Cover = earliest photo in the group.
    expect(groups[0]!.coverId).toBe("a1");
  });

  it("visual pass merges the same garment shot out of order", () => {
    // Two photos far apart in time but visually identical -> one group.
    const photos = [
      p("x", "2024-01-01T10:00:00Z", "1234567890abcdef"),
      p("y", "2024-01-01T10:30:00Z", "1234567890abcdef"),
    ];
    expect(visualPairs(photos)).toEqual([{ a: "x", b: "y" }]);
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]!.photoIds)).toEqual(new Set(["x", "y"]));
  });

  it("keeps visually distinct items in separate groups even when visual is on", () => {
    const photos = [
      p("x", "2024-01-01T10:00:00Z", "0000000000000000"),
      p("y", "2024-01-01T10:30:00Z", "ffffffffffffffff"), // distance 64
    ];
    expect(visualPairs(photos)).toEqual([]);
    expect(autoGroupPhotos(photos)).toHaveLength(2);
  });

  it("puts a photo with no capture time in its own group", () => {
    const photos = [
      p("a1", "2024-01-01T10:00:00Z", "0000000000000000"),
      p("u", null, "abcabcabcabcabca"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(2);
    expect(groups.some((g) => g.photoIds.length === 1 && g.photoIds[0] === "u")).toBe(true);
  });

  it("returns [] for no photos", () => {
    expect(autoGroupPhotos([])).toEqual([]);
  });

  it("VISUAL_MERGE_MAX_DISTANCE is a conservative threshold", () => {
    expect(VISUAL_MERGE_MAX_DISTANCE).toBeLessThanOrEqual(12);
  });
});
