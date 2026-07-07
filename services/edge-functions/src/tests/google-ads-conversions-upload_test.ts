// US-1704: offline conversion upload — datetime formatting, upload-row
// construction, batch skips (dedupe reasons), and partial-failure index parsing.
import { assert, assertEquals } from "@std/assert";
import {
  type AttributionRow,
  buildUploadBatch,
  buildUploadRow,
  failedIndicesFromPartialError,
  formatConversionDateTime,
} from "../lib/google-ads-conversions-upload.ts";
import type { ConversionDefinition } from "../lib/ads-conversions.ts";

const NOW = new Date("2026-07-07T00:00:00.000Z");

function attr(p: Partial<AttributionRow>): AttributionRow {
  return {
    id: "a1",
    click_id: "Cj0gclid",
    click_id_type: "gclid",
    converted_at: "2026-07-01T12:30:45.000Z",
    conversion_type: "subscription_started",
    value: null,
    landing_at: "2026-06-30T00:00:00.000Z",
    ...p,
  };
}

const SUB_DEF: ConversionDefinition = {
  event: "subscription_started",
  name: "Subscription started",
  value: 30,
  conversionAction: "customers/9999/conversionActions/555",
};

Deno.test("formatConversionDateTime → Google's 'yyyy-MM-dd HH:mm:ss+00:00'", () => {
  assertEquals(formatConversionDateTime("2026-07-01T12:30:45.000Z"), "2026-07-01 12:30:45+00:00");
  assertEquals(formatConversionDateTime("nope"), "");
});

Deno.test("buildUploadRow builds a gclid conversion (value falls back to definition)", () => {
  const r = buildUploadRow(attr({}), SUB_DEF, "USD", NOW);
  assert("conversion" in r);
  if ("conversion" in r) {
    assertEquals(r.conversion.gclid, "Cj0gclid");
    assertEquals(r.conversion.conversionAction, "customers/9999/conversionActions/555");
    assertEquals(r.conversion.conversionDateTime, "2026-07-01 12:30:45+00:00");
    assertEquals(r.conversion.conversionValue, 30); // from definition
    assertEquals(r.conversion.currencyCode, "USD");
  }
});

Deno.test("buildUploadRow uses the row's own value when present", () => {
  const r = buildUploadRow(attr({ value: 49.99 }), SUB_DEF, "USD", NOW);
  assert("conversion" in r && r.conversion.conversionValue === 49.99);
});

Deno.test("buildUploadRow skips (no silent drop) with a reason", () => {
  // non-gclid
  assert("skip" in buildUploadRow(attr({ click_id_type: "gbraid" }), SUB_DEF, "USD", NOW));
  // no conversion action configured
  const noAction = buildUploadRow(attr({}), { ...SUB_DEF, conversionAction: undefined }, "USD", NOW);
  assert("skip" in noAction && noAction.skip.includes("no conversion action"));
  // no matching definition
  assert("skip" in buildUploadRow(attr({}), null, "USD", NOW));
  // expired gclid (landing > 90d before now)
  const expired = buildUploadRow(attr({ landing_at: "2026-01-01T00:00:00.000Z" }), SUB_DEF, "USD", NOW);
  assert("skip" in expired && expired.skip.includes("expired"));
});

Deno.test("buildUploadBatch splits uploadable vs skipped", () => {
  const { toUpload, skips } = buildUploadBatch(
    [
      attr({ id: "ok" }),
      attr({ id: "gb", click_id_type: "wbraid" }),
      attr({ id: "noconv", conversion_type: "unknown_event" }),
    ],
    [SUB_DEF],
    "USD",
    NOW,
  );
  assertEquals(toUpload.length, 1);
  assertEquals(toUpload[0].row.id, "ok");
  assertEquals(skips.length, 2);
  assert(skips.every((s) => s.reason.length > 0));
});

Deno.test("failedIndicesFromPartialError extracts flagged operation indices", () => {
  const err = {
    details: [{
      errors: [{ location: { fieldPathElements: [{ fieldName: "conversions", index: 2 }] } }],
    }],
  };
  const idx = failedIndicesFromPartialError(err);
  assert(idx.has(2));
  assertEquals(idx.has(0), false);
  assertEquals(failedIndicesFromPartialError(null).size, 0);
});
