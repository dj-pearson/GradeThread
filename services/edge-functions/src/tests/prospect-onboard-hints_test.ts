// US-3099: the phone already read the tag. Do not pay to read it again.
//
// The claim under test is a COST claim, and it is the same shape as the one
// prospect-repull_test.ts makes: when the client sends an identification the
// server can trust, `identifyProspectGarment` is not called, and the metered AI
// action it would have spent is not spent.
//
// The floor is the load-bearing part. A low-confidence read of a crumpled care
// label is exactly the case Claude is better at, so taking it would trade an AI
// action for a WRONG BRAND — which hands the seller a comp set describing a
// different garment, priced accordingly, with nothing on screen to say so.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  normalizeBarcode,
  ONDEVICE_HINT_CONFIDENCE_FLOOR,
  planFromHints,
} from "../lib/prospect-onboard-hints.ts";

// ── The cost claim ─────────────────────────────────────────────────────────

Deno.test("a confident tag read skips the identifier entirely", () => {
  const plan = planFromHints({
    brandHint: "Patagonia",
    sizeHint: "M",
    hintConfidence: 0.93,
  });
  assert(plan.skipIdentify, "the identifier must not run when the phone already read it");
  assertEquals(plan.reason, "confident-tag-read");
  assertEquals(plan.brand, "Patagonia");
  assertEquals(plan.size, "M");
  assertEquals(
    plan.authoritative,
    false,
    "OCR misreads, and a tag can name a parent brand or a licensee",
  );
  assertEquals(plan.source, "tag");
});

Deno.test("a barcode skips the identifier and IS authoritative", () => {
  // Not a reading: EAN-13 and UPC-A carry a check digit, so a misread fails it
  // rather than producing a plausible wrong number.
  const plan = planFromHints({ barcode: "0123456789012" });
  assert(plan.skipIdentify);
  assertEquals(plan.source, "barcode");
  assertEquals(plan.authoritative, true);
  assertEquals(plan.reason, "barcode");
});

Deno.test("a barcode beats a tag read when both arrive", () => {
  const plan = planFromHints({
    barcode: "0123456789012",
    brandHint: "Patagonia",
    hintConfidence: 0.99,
  });
  assertEquals(plan.source, "barcode");
  assertEquals(plan.authoritative, true);
});

// ── The floor ──────────────────────────────────────────────────────────────

Deno.test("a low-confidence read does NOT skip the identifier", () => {
  const plan = planFromHints({
    brandHint: "Patogonia",
    sizeHint: "M",
    hintConfidence: 0.4,
  });
  assert(!plan.skipIdentify, "an uncertain read is exactly the case Claude is better at");
  assertEquals(plan.reason, "low-confidence");
  assertEquals(
    plan.brand,
    null,
    "the half-trusted brand is DROPPED, not blended — blending is what silently narrows a comp search to the wrong label",
  );
});

Deno.test("the floor is a floor, not a ceiling", () => {
  const justUnder = planFromHints({
    brandHint: "Patagonia",
    hintConfidence: ONDEVICE_HINT_CONFIDENCE_FLOOR - 0.001,
  });
  assert(!justUnder.skipIdentify);

  const exactly = planFromHints({
    brandHint: "Patagonia",
    hintConfidence: ONDEVICE_HINT_CONFIDENCE_FLOOR,
  });
  assert(exactly.skipIdentify, "at the floor is trusted");
});

Deno.test("a missing or non-numeric confidence is treated as zero", () => {
  // A client that sends a brand and forgets the confidence must not be trusted
  // by default. Absent evidence is not strong evidence.
  assert(!planFromHints({ brandHint: "Patagonia" }).skipIdentify);
  assert(!planFromHints({ brandHint: "Patagonia", hintConfidence: "high" }).skipIdentify);
  assert(!planFromHints({ brandHint: "Patagonia", hintConfidence: Number.NaN }).skipIdentify);
});

Deno.test("a size with no brand never skips the identifier", () => {
  // "M" is not an identification. A comp search on size alone returns every
  // medium garment on eBay.
  const plan = planFromHints({ sizeHint: "M", hintConfidence: 0.99 });
  assert(!plan.skipIdentify);
  assertEquals(plan.reason, "low-confidence");
});

Deno.test("no hints at all is today's behaviour, named", () => {
  const plan = planFromHints({});
  assert(!plan.skipIdentify);
  assertEquals(plan.reason, "no-hints");
  assertEquals(plan.source, null);
});

// ── The barcode itself ─────────────────────────────────────────────────────

Deno.test("the four retail lengths are accepted and nothing else is", () => {
  // UPC-E and EAN-8 are 8, UPC-A is 12, EAN-13 is 13.
  assertEquals(normalizeBarcode("01234567"), "01234567");
  assertEquals(normalizeBarcode("012345678912"), "012345678912");
  assertEquals(normalizeBarcode("0123456789012"), "0123456789012");

  // A QR payload or a thrift-store SKU sticker identifies no product in any
  // catalogue we can query. Passing one through as a gtin returns an empty comp
  // set, which reads to the seller as a rare item rather than a bad scan.
  assertEquals(normalizeBarcode("https://example.test/x"), null);
  assertEquals(normalizeBarcode("SKU-99213"), null);
  assertEquals(normalizeBarcode("123"), null);
  assertEquals(normalizeBarcode("12345678901234567"), null);
});

Deno.test("a barcode with any non-digit is refused rather than stripped", () => {
  // Stripping would turn "012-345-678-912" into a valid-looking UPC-A that the
  // scanner never produced, and turn a QR payload's digits into a lookup.
  assertEquals(normalizeBarcode("012-345-678-912"), null);
  assertEquals(normalizeBarcode(" 0123456789012 "), "0123456789012", "outer whitespace is trimmed");
});

Deno.test("non-strings and empties are simply absent", () => {
  for (const value of [null, undefined, 42, {}, [], ""]) {
    assertEquals(normalizeBarcode(value), null);
  }
});

// ── Bounds ─────────────────────────────────────────────────────────────────

Deno.test("an absurd brand string is truncated rather than refused", () => {
  // A 4KB brand is a broken client, not an attack, and refusing the whole scan
  // over it would cost the seller the aisle they are standing in.
  const plan = planFromHints({
    brandHint: "x".repeat(4000),
    hintConfidence: 0.99,
  });
  assert(plan.skipIdentify);
  assertEquals(plan.brand?.length, 120);
});
