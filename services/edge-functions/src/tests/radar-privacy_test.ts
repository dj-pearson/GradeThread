// US-1861: the Thrift Radar privacy primitives.
//
// These are the three transforms the whole consent story rests on, so they are
// tested directly rather than through a route. `radar-privacy.ts` deliberately
// imports nothing that touches Supabase or the environment, so this file needs
// no env dance.

import { assert, assertEquals } from "@std/assert";
import {
  buildRadarEventRow,
  clampPrecision,
  coarseCell,
  contributorEpoch,
  contributorKey,
  DEFAULT_GEOHASH_PRECISION,
  MAX_GEOHASH_PRECISION,
  parseFix,
} from "../lib/radar-privacy.ts";

const SALT = "test-radar-salt";

Deno.test("coarseCell: encodes a known coordinate to the standard geohash", () => {
  // Reference values from the geohash spec's worked example (Berlin,
  // 52.517037 / 13.408932 → u33dc...). Precision is what makes it coarse.
  assertEquals(coarseCell(52.517037, 13.408932, 5), "u33dc");
  assertEquals(coarseCell(52.517037, 13.408932, 6), "u33dc0");
  // A prefix relationship is what makes cells nest — the aggregate layer relies
  // on it, and it also proves precision is genuinely a coarsening knob.
  assert(coarseCell(52.517037, 13.408932, 6)!.startsWith(coarseCell(52.517037, 13.408932, 5)!));
});

Deno.test("coarseCell: two fixes metres apart collapse into the SAME cell", () => {
  // The privacy claim in one assertion: a 6-character cell is ~1.2 km x 0.6 km,
  // so standing at one end of a thrift store or the other is indistinguishable.
  const a = coarseCell(40.712776, -74.005974, 6);
  const b = coarseCell(40.712900, -74.006100, 6);
  assertEquals(a, b);
  assert(a !== null);
});

Deno.test("coarseCell: refuses an out-of-range or non-finite fix", () => {
  assertEquals(coarseCell(91, 0), null);
  assertEquals(coarseCell(0, 181), null);
  assertEquals(coarseCell(Number.NaN, 0), null);
});

Deno.test("clampPrecision: cannot be turned past the schema CHECK", () => {
  // The DB caps geohash length at 7. If config could ask for 12, the insert
  // would start failing — or worse, the CHECK would be relaxed to match.
  assertEquals(clampPrecision(12), MAX_GEOHASH_PRECISION);
  assertEquals(clampPrecision(1), 4);
  assertEquals(clampPrecision(undefined), DEFAULT_GEOHASH_PRECISION);
  assertEquals(clampPrecision("6"), DEFAULT_GEOHASH_PRECISION);
});

Deno.test("contributorEpoch: stable inside a window, different across one", () => {
  const day = 86_400_000;
  const base = new Date(1_760_000_000_000);
  const sameWindow = new Date(base.getTime() + day);
  const nextWindow = new Date(base.getTime() + 8 * day);
  assertEquals(contributorEpoch(base, 7), contributorEpoch(sameWindow, 7));
  assert(contributorEpoch(base, 7) !== contributorEpoch(nextWindow, 7));
});

Deno.test("contributorKey: rotates, and is not the account id", async () => {
  const account = "11111111-1111-4111-8111-111111111111";
  const e1 = await contributorKey(account, 100, SALT);
  const e1again = await contributorKey(account, 100, SALT);
  const e2 = await contributorKey(account, 101, SALT);
  const other = await contributorKey("22222222-2222-4222-8222-222222222222", 100, SALT);
  const otherSalt = await contributorKey(account, 100, "different-salt");

  // Distinct contributors are countable inside a window…
  assertEquals(e1, e1again);
  assert(e1 !== other);
  // …but the same person is not followable into the next one.
  assert(e1 !== e2);
  // And the digest is deployment-salted, so it is not rainbow-tableable.
  assert(e1 !== otherSalt);
  // Nothing readable survives.
  assertEquals(e1.length, 64);
  assert(!e1.includes(account));
});

Deno.test("buildRadarEventRow: the row has no coordinate and no account field", async () => {
  const row = await buildRadarEventRow({
    accountId: "11111111-1111-4111-8111-111111111111",
    lat: 40.712776,
    lng: -74.005974,
    brand: "  Patagonia  ",
    category: "Clothing > Jackets",
    gradeBand: "high",
    verdict: "buy",
    at: new Date("2026-08-07T12:00:00.000Z"),
    salt: SALT,
    precision: 6,
    rotationDays: 7,
  });
  assert(row);

  // The guarantee, stated as the SET of keys rather than as an absence of one
  // field — a new coordinate column would have to be added here to pass.
  assertEquals(Object.keys(row!).sort(), [
    "brand",
    "category",
    "contributor_key",
    "geohash",
    "grade_band",
    "key_epoch",
    "scanned_at",
    "verdict",
  ]);
  assertEquals(row!.geohash.length, 6);
  assertEquals(row!.brand, "Patagonia");
  const serialized = JSON.stringify(row);
  assert(!serialized.includes("40.712"), "a latitude survived into the row");
  assert(!serialized.includes("-74.005"), "a longitude survived into the row");
  assert(
    !serialized.includes("11111111-1111-4111-8111-111111111111"),
    "the account id survived into the row",
  );
});

Deno.test("buildRadarEventRow: an unusable fix produces no contribution", async () => {
  const row = await buildRadarEventRow({
    accountId: "11111111-1111-4111-8111-111111111111",
    lat: 999,
    lng: 999,
    brand: null,
    category: null,
    gradeBand: "ungraded",
    verdict: "unknown",
    at: new Date(),
    salt: SALT,
  });
  assertEquals(row, null);
});

Deno.test("parseFix: a half-supplied or Null-Island fix is refused", () => {
  assertEquals(parseFix(40.7, undefined), null);
  assertEquals(parseFix("40.7", -74), null);
  assertEquals(parseFix(0, 0), null);
  assertEquals(parseFix(91, 0), null);
  assertEquals(parseFix(40.7, -74), { lat: 40.7, lng: -74 });
});
