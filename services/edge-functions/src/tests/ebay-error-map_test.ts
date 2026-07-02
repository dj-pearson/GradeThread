// US-567: publish error IDs map to actionable, field-tagged fix messages, and
// unknown/empty inputs fall through to null (caller uses the generic fallback).
// US-1511: ebayFailureDetail extends the same contract to the revise/price/end/
// negotiation paths — mapped message when an id matches, caller's generic
// otherwise, NEVER the raw provider blob.

import { assert, assertEquals } from "@std/assert";
import {
  ebayFailureDetail,
  mapEbayError,
  EBAY_PUBLISH_GENERIC_FIX,
} from "../lib/ebay-error-map.ts";

Deno.test("maps a known condition error to a condition-field fix", () => {
  assertEquals(mapEbayError([25019])?.field, "condition");
});

Deno.test("maps required-specifics error to the specifics field", () => {
  const fix = mapEbayError([25709]);
  assertEquals(fix?.field, "specifics");
});

Deno.test("returns the FIRST matching id when several are present", () => {
  // 99999 is unknown, 25710 (category) is known → category wins.
  assertEquals(mapEbayError([99999, 25710])?.field, "category");
});

Deno.test("unknown / empty / missing ids return null", () => {
  assertEquals(mapEbayError([88888]), null);
  assertEquals(mapEbayError([]), null);
  assertEquals(mapEbayError(undefined), null);
  assertEquals(mapEbayError(null), null);
});

Deno.test("a generic fallback string is exported for the no-match case", () => {
  assertEquals(typeof EBAY_PUBLISH_GENERIC_FIX, "string");
  assertEquals(EBAY_PUBLISH_GENERIC_FIX.length > 0, true);
});

Deno.test("ebayFailureDetail returns the mapped message when an errorId matches", () => {
  const err = Object.assign(
    new Error('eBay PUT /sell/inventory/... failed (400): {"errors":[...]}'),
    { ebayErrorIds: [25019] },
  );
  assertEquals(ebayFailureDetail(err, "generic"), mapEbayError([25019])?.message);
});

Deno.test("ebayFailureDetail NEVER leaks the raw provider blob (unknown id / plain error)", () => {
  const raw = 'eBay POST /sell/offer/... failed (400): {"errors":[{"errorId":88888}]}';
  const withUnknownId = Object.assign(new Error(raw), { ebayErrorIds: [88888] });
  assertEquals(ebayFailureDetail(withUnknownId, "op-specific generic"), "op-specific generic");
  assertEquals(ebayFailureDetail(new Error(raw), "op-specific generic"), "op-specific generic");
  assertEquals(ebayFailureDetail("string error", "op-specific generic"), "op-specific generic");
  assert(!ebayFailureDetail(withUnknownId, "g").includes("errorId"));
});
