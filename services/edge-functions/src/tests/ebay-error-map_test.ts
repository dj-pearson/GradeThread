// US-567: publish error IDs map to actionable, field-tagged fix messages, and
// unknown/empty inputs fall through to null (caller uses the generic fallback).

import { assertEquals } from "@std/assert";
import { mapEbayError, EBAY_PUBLISH_GENERIC_FIX } from "../lib/ebay-error-map.ts";

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
