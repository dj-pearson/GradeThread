// US-1097: garment fingerprint pure helpers (wear score, defect summary,
// payload shape, perceptual similarity). No DB, no image decode.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildFingerprintedEventPayload,
  buildFingerprintPayload,
  fingerprintSimilarity,
  hashSimilarity,
  phashesByType,
  summarizeDefects,
  wearScore,
  WEAR_SCORE_MAX,
} from "../lib/garment-fingerprint.ts";

Deno.test("wearScore: increases with wear, bounded [0,10]", () => {
  assertEquals(wearScore(10), 0); // pristine → no wear
  assertEquals(wearScore(8.5), 1.5);
  assertEquals(wearScore(3), 7);
  assertEquals(wearScore(0), WEAR_SCORE_MAX);
  assertEquals(wearScore(12), 0); // out-of-range condition clamps
  assertEquals(wearScore(-5), WEAR_SCORE_MAX);
});

Deno.test("summarizeDefects: distinct, sorted, lowercased locations", () => {
  const s = summarizeDefects([
    { defect_type: "pilling", location: "Left Sleeve" },
    { defect_type: "stain", location: "Collar" },
    { defect_type: "pilling", location: "Left Sleeve" },
    { defect_type: null, location: null },
  ]);
  assertEquals(s.count, 4); // total, including dups + null
  assertEquals(s.types, ["pilling", "stain"]);
  assertEquals(s.locations, ["collar", "left sleeve"]);
});

Deno.test("phashesByType: one valid hash per type, first wins", () => {
  const map = phashesByType([
    { image_type: "front", phash: "0123456789abcdef" },
    { image_type: "front", phash: "ffffffffffffffff" }, // dup type → ignored
    { image_type: "back", phash: "fedcba9876543210" },
    { image_type: "label", phash: "BADHASH" }, // invalid → excluded
    { image_type: "detail", phash: null },
  ]);
  assertEquals(map, {
    front: "0123456789abcdef",
    back: "fedcba9876543210",
  });
});

Deno.test("buildFingerprintPayload: stable v1 shape", () => {
  const p = buildFingerprintPayload({
    phashes: { front: "0123456789abcdef" },
    defects: [{ defect_type: "tear", location: "Hem" }],
    measurements: { chest: 21 },
  });
  assertEquals(p.v, 1);
  assertEquals(p.phashes, { front: "0123456789abcdef" });
  assertEquals(p.defects.count, 1);
  assertEquals(p.measurements, { chest: 21 });
});

Deno.test("buildFingerprintedEventPayload: aggregate-only, PII-free (US-1137)", () => {
  const p = buildFingerprintedEventPayload({
    phashes: { front: "0123456789abcdef", back: "fedcba9876543210" },
    defectCount: 3,
    overallScore: 8.5,
  });
  assertEquals(p, { v: 1, photo_count: 2, defect_count: 3, wear_score: 1.5 });
  // No hashes, images, or identity keys leak into the public-timeline payload.
  const keys = Object.keys(p);
  assert(!keys.some((k) => /(^|_)(id|email|user|owner|handle|name)$/i.test(k)));
  assert(!JSON.stringify(p).includes("0123456789abcdef"));

  // Empty photo set still produces a valid, count-zero payload.
  assertEquals(
    buildFingerprintedEventPayload({ phashes: {}, defectCount: 0, overallScore: 10 }),
    { v: 1, photo_count: 0, defect_count: 0, wear_score: 0 },
  );
});

Deno.test("hashSimilarity: 1 for identical, 0 for opposite", () => {
  assertEquals(hashSimilarity("0123456789abcdef", "0123456789abcdef"), 1);
  assertEquals(hashSimilarity("0000000000000000", "ffffffffffffffff"), 0);
  // One differing hex nibble (f vs e = 1 bit) → 63/64.
  assert(Math.abs(hashSimilarity("000000000000000f", "000000000000000e") - 63 / 64) < 1e-9);
});

Deno.test("fingerprintSimilarity: best over shared photo types", () => {
  const a = { front: "0123456789abcdef", back: "0000000000000000" };
  const b = { front: "0123456789abcdef", back: "ffffffffffffffff" };
  const r = fingerprintSimilarity(a, b);
  assertEquals(r.score, 1); // front matches exactly → best is 1
  assertEquals(r.comparedTypes.sort(), ["back", "front"]);
  // No shared types → 0.
  assertEquals(fingerprintSimilarity({ front: "0123456789abcdef" }, { back: "0123456789abcdef" }).score, 0);
});
