// US-1700: conversion wiring — click-id normalization, platform mapping, the
// event → conversion-definition map, and the attribution upsert (fake client).
import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_CONVERSION_DEFINITIONS,
  mapEventToConversion,
  normalizeClickId,
  platformForClickIdType,
  recordAttribution,
} from "../lib/ads-conversions.ts";

Deno.test("normalizeClickId trims + bounds", () => {
  assertEquals(normalizeClickId("  abc123 "), "abc123");
  assertEquals(normalizeClickId(""), null);
  assertEquals(normalizeClickId("   "), null);
  assertEquals(normalizeClickId(42 as unknown as string), null);
  assertEquals(normalizeClickId("x".repeat(513)), null);
});

Deno.test("platformForClickIdType maps Google click params", () => {
  assertEquals(platformForClickIdType("gclid"), "google_ads");
  assertEquals(platformForClickIdType("GBRAID"), "google_ads");
  assertEquals(platformForClickIdType("wbraid"), "google_ads");
  assertEquals(platformForClickIdType("utm_source"), null);
});

Deno.test("mapEventToConversion resolves definitions (case-insensitive), else null", () => {
  const sub = mapEventToConversion("subscription_started");
  assert(sub);
  assertEquals(sub?.value, 30);
  assertEquals(mapEventToConversion("Grade_Purchased")?.event, "grade_purchased");
  assertEquals(mapEventToConversion("not_a_conversion"), null);
  // default set covers the four AC events
  assertEquals(DEFAULT_CONVERSION_DEFINITIONS.length, 4);
});

function fakeSupabase() {
  const calls: Array<{ table: string; row: Record<string, unknown>; onConflict?: string }> = [];
  const client = {
    from(table: string) {
      return {
        upsert(row: Record<string, unknown>, opts?: { onConflict?: string }) {
          calls.push({ table, row, onConflict: opts?.onConflict });
          return Promise.resolve({ error: null });
        },
      };
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { client, calls };
}

Deno.test("recordAttribution upserts a landing keyed on click_id", async () => {
  const { client, calls } = fakeSupabase();
  const ok = await recordAttribution(client, {
    clickId: "  Cj0xyz ",
    clickIdType: "gclid",
    ownerUserId: "user-1",
  });
  assert(ok);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].table, "ad_click_attributions");
  assertEquals(calls[0].onConflict, "click_id");
  assertEquals(calls[0].row.click_id, "Cj0xyz");
  assertEquals(calls[0].row.platform, "google_ads");
  assertEquals(calls[0].row.owner_user_id, "user-1");
  // A landing (no conversion) leaves converted_at unset.
  assertEquals(calls[0].row.converted_at, undefined);
});

Deno.test("recordAttribution writes conversion fields when present", async () => {
  const { client, calls } = fakeSupabase();
  await recordAttribution(client, {
    clickId: "abc",
    clickIdType: "gclid",
    conversion: { type: "subscription_started", value: 30 },
  });
  assertEquals(calls[0].row.conversion_type, "subscription_started");
  assertEquals(calls[0].row.value, 30);
  assert(typeof calls[0].row.converted_at === "string");
});

Deno.test("recordAttribution rejects an unsupported click id", async () => {
  const { client, calls } = fakeSupabase();
  const ok = await recordAttribution(client, { clickId: "", clickIdType: "gclid" });
  assertEquals(ok, false);
  assertEquals(calls.length, 0);
  const ok2 = await recordAttribution(client, { clickId: "abc", clickIdType: "utm_source" });
  assertEquals(ok2, false);
});
