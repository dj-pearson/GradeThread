// US-3060: the on-marketplace verified badge. The decision logic, which is all
// of the parts that can be wrong in a way a live test would not catch.
//
// The rule this file exists to hold is AC5: ABSENCE IS NOT A CLAIM. A miss
// returns nothing, never an "unverified" marker. Rendering a negative badge
// would turn every ungraded listing on the page into something our extension
// appears to have judged, and most of those sellers have never heard of us.
import assert from "node:assert/strict";

import {
  BADGE_PLATFORMS,
  type BadgeSourceRow,
  badgeResponse,
  certificatePath,
  isBadgePlatform,
  MAX_BADGE_IDS,
  parseBadgeQuery,
  shapeListingCertificates,
} from "../lib/listing-certificates.ts";

function row(over: Partial<BadgeSourceRow> = {}): BadgeSourceRow {
  return {
    listingId: "1234567890",
    certificateId: "GT-ABC123",
    overallScore: 8.5,
    gradeTier: "Excellent",
    gradedAt: "2026-09-01T10:00:00.000Z",
    optedOut: false,
    ...over,
  };
}

// ── The query ────────────────────────────────────────────────────────

Deno.test("US-3060: only the three platforms with an id extractor are accepted", () => {
  assert.deepEqual([...BADGE_PLATFORMS], ["ebay", "poshmark", "mercari"]);
  for (const p of BADGE_PLATFORMS) assert.equal(isBadgePlatform(p), true);
  // depop is a real ListingPlatform and is NOT a badge platform: the extension
  // has no way to read a listing id off a Depop page without scraping, and a
  // platform in this list with no extractor is a request that always misses.
  for (const p of ["depop", "grailed", "shopify", "", null, 7]) {
    assert.equal(isBadgePlatform(p), false, `${JSON.stringify(p)} was accepted`);
  }
  const bad = parseBadgeQuery("depop", "1");
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.code, "bad_platform");
});

Deno.test("US-3060: ids are trimmed, de-duplicated and capped", () => {
  const out = parseBadgeQuery("ebay", " 111 , 222,111,, 333 ");
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.ids, ["111", "222", "333"]);
});

Deno.test("US-3060: de-duplication happens BEFORE the cap", () => {
  // A grid showing the same item twice must not spend two of its 24 slots on
  // it, and 30 ids that are really 3 items is a legitimate request.
  const ids = Array(30).fill("111").concat(["222", "333"]).join(",");
  const out = parseBadgeQuery("ebay", ids);
  assert.equal(out.ok, true, "30 duplicate ids were rejected as over the cap");
  if (!out.ok) return;
  assert.deepEqual(out.ids, ["111", "222", "333"]);
});

Deno.test("US-3060: 25 distinct ids is over the cap and says so", () => {
  const ids = Array.from({ length: MAX_BADGE_IDS + 1 }, (_, i) => `id${i}`).join(",");
  const out = parseBadgeQuery("ebay", ids);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.code, "too_many_ids");
  assert.match(out.error, new RegExp(String(MAX_BADGE_IDS)));
  // And exactly 24 is fine — the boundary, in both directions.
  const atCap = parseBadgeQuery(
    "ebay",
    Array.from({ length: MAX_BADGE_IDS }, (_, i) => `id${i}`).join(","),
  );
  assert.equal(atCap.ok, true);
});

Deno.test("US-3060: a missing or empty ids list is refused, not treated as all", () => {
  for (const v of [undefined, null, "", " , , ", 42]) {
    const out = parseBadgeQuery("ebay", v);
    assert.equal(out.ok, false, `${JSON.stringify(v)} produced a query`);
    if (out.ok) return;
    assert.equal(out.code, "no_ids");
  }
});

Deno.test("US-3060: an absurdly long id is dropped rather than sent to the database", () => {
  const out = parseBadgeQuery("ebay", `111,${"x".repeat(500)},222`);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.ids, ["111", "222"]);
});

// ── The shaping, and the rules that drop a row ───────────────────────

Deno.test("US-3060: a complete row becomes a badge", () => {
  const [badge] = shapeListingCertificates([row()]);
  assert.ok(badge);
  assert.equal(badge.listingId, "1234567890");
  assert.equal(badge.certificateId, "GT-ABC123");
  assert.equal(badge.grade, 8.5);
  assert.equal(badge.tier, "Excellent");
  assert.equal(badge.path, "/cert/GT-ABC123");
  // The path is site-relative on purpose: the caller adds the origin and the
  // utm_medium=badge, so this module never encodes where the site lives.
  assert.ok(!badge.path.startsWith("http"), badge.path);
});

Deno.test("US-3060: an uncertified grade produces NOTHING, not an unverified badge", () => {
  // A grade report without a certificate_id is not public. Its EXISTENCE is not
  // public either, which is why this drops the row rather than returning a
  // "graded but not certified" marker.
  assert.deepEqual(shapeListingCertificates([row({ certificateId: null })]), []);
});

Deno.test("US-3060: an opted-out seller's listing produces nothing", () => {
  assert.deepEqual(shapeListingCertificates([row({ optedOut: true })]), []);
  // And the opt-out is per row, so one seller opting out does not silence another.
  const out = shapeListingCertificates([
    row({ listingId: "a", optedOut: true }),
    row({ listingId: "b", optedOut: false }),
  ]);
  assert.deepEqual(out.map((b) => b.listingId), ["b"]);
});

Deno.test("US-3060: a row with no score or no tier is dropped", () => {
  // A badge reading "GradeThread verified" with a blank grade is worse than no
  // badge: it makes a claim and shows no evidence for it.
  for (const bad of [
    row({ overallScore: null }),
    row({ overallScore: Number.NaN }),
    row({ gradeTier: null }),
    row({ gradeTier: "" }),
  ]) {
    assert.deepEqual(shapeListingCertificates([bad]), [], JSON.stringify(bad));
  }
});

Deno.test("US-3060: a duplicate listing id resolves deterministically, first wins", () => {
  // A listing that somehow carries two graded items must not make the response
  // depend on the order the database happened to return rows in.
  const out = shapeListingCertificates([
    row({ listingId: "dup", certificateId: "GT-FIRST" }),
    row({ listingId: "dup", certificateId: "GT-SECOND" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.certificateId, "GT-FIRST");
});

Deno.test("US-3060: the grade is rounded to one decimal, the scale's own step", () => {
  assert.equal(shapeListingCertificates([row({ overallScore: 8.449 })])[0]?.grade, 8.4);
  assert.equal(shapeListingCertificates([row({ overallScore: 8.45 })])[0]?.grade, 8.5);
  assert.equal(shapeListingCertificates([row({ overallScore: 10 })])[0]?.grade, 10);
});

Deno.test("US-3060: certificatePath is the app's own route shape", () => {
  // If /cert/:id ever moves, this is the one place that has to change and the
  // test that says so.
  assert.equal(certificatePath("GT-XYZ"), "/cert/GT-XYZ");
});

// ── The response ─────────────────────────────────────────────────────

Deno.test("US-3060: the response carries a count and no ids beyond the hits", () => {
  const body = badgeResponse("ebay", shapeListingCertificates([row(), row({ listingId: "b" })]));
  assert.equal(body.platform, "ebay");
  assert.equal(body.found, 2);
  assert.equal(body.certificates.length, 2);
});

Deno.test("US-3060: no hits is a well-formed empty answer, never an error shape", () => {
  // The extension renders nothing on an empty set AND nothing on a failure, so
  // the two must not be told apart by shape — a caller that branched on the
  // difference would be one refactor away from rendering a negative badge.
  const body = badgeResponse("poshmark", []);
  assert.equal(body.found, 0);
  assert.deepEqual(body.certificates, []);
  assert.ok(!("error" in (body as unknown as Record<string, unknown>)));
});

Deno.test("US-3060: the response exposes no user id and no listing url", () => {
  const json = JSON.stringify(badgeResponse("ebay", shapeListingCertificates([row()])));
  for (const forbidden of ["user_id", "userId", "listing_url", "listingUrl", "price", "http"]) {
    assert.ok(!json.includes(forbidden), `${forbidden} reached an anonymous response: ${json}`);
  }
});
