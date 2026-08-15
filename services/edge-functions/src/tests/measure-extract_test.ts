// US-1573: pure parts of measurement extraction — proposal coercion, the
// deterministic edge snap, plausibility bands, quarter-inch rounding, and the
// fill-only provenance merge. The single model call is NOT exercised here
// (its billing lives in the route via withAiAction; the coverage drift test
// enforces that).
//
//   deno test --allow-env --allow-read src/tests/measure-extract_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
Deno.env.set(
  "ANTHROPIC_API_KEY",
  Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key",
);

const {
  mergeMeasurementsFillOnly,
  normalizeProposals,
  plausibilityBand,
  roundQuarterInch,
  snapEndpoint,
} = await import("../lib/measure-extract.ts");
const { fitHomography, applyHomography } = await import(
  "../lib/measure-detect.ts"
);

Deno.test("roundQuarterInch snaps to 0.25 steps", () => {
  assertEquals(roundQuarterInch(22.13), 22.25);
  assertEquals(roundQuarterInch(22.11), 22);
  assertEquals(roundQuarterInch(0.4), 0.5);
});

Deno.test("normalizeProposals drops malformed / out-of-range / duplicate / unknown keys", () => {
  const allowed = new Set(["chest", "length"]);
  const out = normalizeProposals(
    [
      { key: "chest", x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, confidence: 0.8 },
      { key: "chest", x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.2, confidence: 0.9 }, // dup
      { key: "waist", x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2, confidence: 1 }, // not allowed
      { key: "length", x1: 1.4, y1: 0.5, x2: 0.9, y2: 0.5, confidence: 0.8 }, // out of range
      { key: "length", x1: 0.5, y1: 0.05, x2: 0.5, y2: 0.95, confidence: 9 }, // conf clamps
      "garbage",
    ],
    allowed,
  );
  assertEquals(out.length, 2);
  assertEquals(out[0].key, "chest");
  assertEquals(out[1].key, "length");
  assertEquals(out[1].confidence, 1);
});

Deno.test("snapEndpoint settles on a synthetic garment edge", () => {
  // 200x100: dark garment occupies x >= 120 (edge at x=120). Propose an
  // endpoint 9px short of the edge, direction along +x — must snap to ~120.
  const w = 200, h = 100;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) gray[y * w + x] = x >= 120 ? 40 : 220;
  }
  const snapped = snapEndpoint(
    { width: w, height: h, gray },
    [111, 50],
    [1, 0],
    15,
  );
  assert(Math.abs(snapped[0] - 120) <= 3, `snapped to ${snapped[0]}`);
  assertEquals(snapped[1], 50);
});

Deno.test("snapEndpoint leaves uniform regions untouched (noise floor)", () => {
  const w = 100, h = 100;
  const gray = new Uint8Array(w * h).fill(200);
  const snapped = snapEndpoint(
    { width: w, height: h, gray },
    [50, 50],
    [1, 0],
    20,
  );
  assertEquals(snapped, [50, 50]);
});

Deno.test("plausibilityBand narrows chest by size tag and stays generous otherwise", () => {
  assertEquals(plausibilityBand("top", "chest", "L"), [20, 26]);
  assertEquals(plausibilityBand("top", "chest", null), [14, 36]);
  assertEquals(plausibilityBand("bottom", "inseam", "L"), [4, 40]);
  assertEquals(plausibilityBand("watch", "case_diameter", null), null);
});

Deno.test("fill-only merge: seller values survive, AI values refresh, blanks fill", () => {
  const extracted = [
    {
      key: "chest",
      label: "Chest",
      endpoints: [[0, 0], [1, 1]] as [[number, number], [number, number]],
      inches: 22,
      confidence: 0.9,
      flagged: false,
      flagReason: null,
    },
    {
      key: "length",
      label: "Length",
      endpoints: [[0, 0], [1, 1]] as [[number, number], [number, number]],
      inches: 28.5,
      confidence: 0.8,
      flagged: false,
      flagReason: null,
    },
    {
      key: "sleeve",
      label: "Sleeve",
      endpoints: [[0, 0], [1, 1]] as [[number, number], [number, number]],
      inches: 25,
      confidence: 0.7,
      flagged: true,
      flagReason: "low_confidence",
    },
  ];
  const merged = mergeMeasurementsFillOnly(
    // chest was typed by the SELLER (no ai source); length was AI-measured
    // before (stale 27); sleeve is blank.
    { chest: 21, length: 27 },
    { "measurements.length": { source: "ai_measured" } },
    extracted,
  );
  assertEquals(merged.measurements["chest"], 21); // seller wins
  assertEquals(merged.measurements["length"], 28.5); // AI refreshes AI
  // US-2608: the sleeve was FLAGGED (low confidence), so the blank stays blank.
  // This used to fill it, which is how an implausible number reached the item,
  // the eBay Size specifics and the measurements photo a buyer sees. A blank is
  // honest; a number is a promise.
  assert(!("sleeve" in merged.measurements));
  assertEquals(merged.written.sort(), ["length"]);
  assert(!("measurements.chest" in merged.aiFieldSources));
  assert(!("measurements.sleeve" in merged.aiFieldSources));
  const lengthSrc = merged.aiFieldSources["measurements.length"] as {
    source: string;
    flagged: boolean;
  };
  assertEquals(lengthSrc.source, "ai_measured");
  assertEquals(lengthSrc.flagged, false);
});

Deno.test("endpoints through a calibration homography yield true inches", () => {
  // 100 px/in pure-scale calibration; a 2200px pit-to-pit line = 22in.
  const H = fitHomography(
    [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
    [[0, 0], [10, 0], [10, 10], [0, 10]],
  )!;
  const [ax, ay] = applyHomography(H, 100, 500);
  const [bx, by] = applyHomography(H, 2300, 500);
  assertEquals(Math.hypot(ax - bx, ay - by), 22);
});

Deno.test("measurement-templates edge mirror matches the web copy byte-for-byte", async () => {
  const edge = await Deno.readTextFile(
    new URL("../lib/measurement-templates.ts", import.meta.url),
  );
  const web = await Deno.readTextFile(
    new URL("../../../../src/lib/measurement-templates.ts", import.meta.url),
  );
  assertEquals(edge, web, "regenerate the edge mirror from src/lib/measurement-templates.ts");
});

// ── US-2608: the crotch is ONE landmark, and a number we don't believe ────────
//    never becomes a buyer-facing fact.

const { reconcileCrotch, CROTCH_AGREEMENT_IN } = await import(
  "../lib/measure-extract.ts"
);

/** 100 px/in pure-scale calibration: image px / 100 = inches. */
const SCALE_H = [1 / 100, 0, 0, 0, 1 / 100, 0, 0, 0, 1];

function bottomPair(
  riseCrotch: [number, number],
  inseamCrotch: [number, number],
) {
  return [
    {
      // rise runs UP from the crotch to the waistband
      key: "rise",
      label: "Front rise",
      endpoints: [riseCrotch, [riseCrotch[0], riseCrotch[1] - 1000]] as
        [[number, number], [number, number]],
      inches: 10,
      confidence: 0.9,
      flagged: false,
      flagReason: null,
    },
    {
      // inseam runs DOWN from the crotch to the hem
      key: "inseam",
      label: "Inseam",
      endpoints: [inseamCrotch, [inseamCrotch[0], inseamCrotch[1] + 3000]] as
        [[number, number], [number, number]],
      inches: 30,
      confidence: 0.9,
      flagged: false,
      flagReason: null,
    },
  ];
}

Deno.test("US-2608: rise and inseam agreeing on the crotch are left alone", () => {
  // Same point, so nothing to reconcile.
  const out = reconcileCrotch(bottomPair([500, 1200], [500, 1200]), SCALE_H);
  assert(out.every((m) => !m.flagged));
});

Deno.test("US-2608: a crotch the two measurements disagree on flags BOTH", () => {
  // 300px apart at 100px/in = 3in — well past the 1in tolerance. One of the two
  // is wrong and we cannot tell which, so neither may be published.
  const out = reconcileCrotch(bottomPair([500, 1200], [500, 1500]), SCALE_H);
  assertEquals(out.filter((m) => m.flagged).map((m) => m.key).sort(), [
    "inseam",
    "rise",
  ]);
  assert(out[0].flagReason?.startsWith("crotch_disagreement"));
});

Deno.test("US-2608: a gap inside the tolerance is not a disagreement", () => {
  // Half an inch apart — landmark jitter, not a mislocated crotch.
  const out = reconcileCrotch(bottomPair([500, 1200], [500, 1250]), SCALE_H);
  assert(out.every((m) => !m.flagged));
  assert(CROTCH_AGREEMENT_IN >= 0.5);
});

Deno.test("US-2608: the check stands down on a garment shot sideways", () => {
  // Both measurements horizontal: "above" and "below" carry no meaning, so
  // guessing which endpoint is the crotch would invent a failure.
  const sideways = [
    {
      key: "rise",
      label: "Front rise",
      endpoints: [[1200, 500], [200, 500]] as [[number, number], [number, number]],
      inches: 10,
      confidence: 0.9,
      flagged: false,
      flagReason: null,
    },
    {
      key: "inseam",
      label: "Inseam",
      endpoints: [[1500, 500], [4500, 500]] as [[number, number], [number, number]],
      inches: 30,
      confidence: 0.9,
      flagged: false,
      flagReason: null,
    },
  ];
  assert(reconcileCrotch(sideways, SCALE_H).every((m) => !m.flagged));
});

Deno.test("US-2608: a garment with only one of the pair is untouched", () => {
  const riseOnly = bottomPair([500, 1200], [500, 9999]).slice(0, 1);
  assert(reconcileCrotch(riseOnly, SCALE_H).every((m) => !m.flagged));
});

Deno.test("US-2608: the rise band rejects the mislocated-crotch signature", () => {
  // The failure sellers report: the crotch lands partway down the leg, so the
  // rise swallows the error. 18in is not a rise on any garment, and the old
  // [6, 20] band waved exactly this through.
  const [lo, hi] = plausibilityBand("bottom", "rise", null)!;
  assert(18 > hi, "an 18in front rise must be outside the band");
  assert(lo <= 8 && hi >= 13, "ordinary rises (8-13in) must stay inside it");
  // A suit's trouser half is measured with the same tape.
  assertEquals(plausibilityBand("suit", "rise", null), [lo, hi]);
});
