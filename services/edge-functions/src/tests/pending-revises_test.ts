// US-9202: the pending-revise queue's state machine, pure.
//
//   deno test --allow-read src/tests/pending-revises_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  applyReviseOutcome,
  EXTENSION_REVISE_PLATFORMS,
  isAutoRevisable,
  isExtensionRevisePlatform,
  planReviseStamp,
  REVISABLE_FIELDS,
  REVISE_MAX_ATTEMPTS,
  type RevisePendingMarker,
} from "../lib/pending-revises.ts";
import { EXTENSION_DELIST_PLATFORMS } from "../lib/cross-listing-sale.ts";

const T0 = "2026-09-01T10:00:00.000Z";
const T1 = "2026-09-01T11:00:00.000Z";
const T2 = "2026-09-02T09:00:00.000Z";

Deno.test("the revise platforms are the delist platforms, derived not restated", () => {
  assertEquals([...EXTENSION_REVISE_PLATFORMS].sort(), [...EXTENSION_DELIST_PLATFORMS].sort());
  assert(isExtensionRevisePlatform("poshmark"));
  assert(isExtensionRevisePlatform("mercari"));
  assert(isExtensionRevisePlatform("vinted"));
  assert(!isExtensionRevisePlatform("ebay"), "eBay revises through its API, never this queue");
  assert(!isExtensionRevisePlatform("shopify"));
  assert(!isExtensionRevisePlatform(null));
});

Deno.test("a first edit stamps the fields, the time and the source", () => {
  const m = planReviseStamp(null, ["price", "price", "title"], T0, "edit");
  assertEquals(m, { fields: ["price", "title"], queued_at: T0, source: "edit", attempts: 0 });
  assertEquals([...REVISABLE_FIELDS], ["price", "title", "description", "photos"]);
});

Deno.test("a second edit before the first applied merges and keeps the stale-since date", () => {
  const first = planReviseStamp(null, ["price"], T0, "edit");
  const failedOnce = applyReviseOutcome(first, { applied: false, manual: true, error: "no editor" }, T1);
  assert(!failedOnce.cleared);
  const second = planReviseStamp(failedOnce.marker, ["photos", "price"], T2, "bulk_price");
  assertEquals(second.fields, ["price", "photos"]);
  assertEquals(second.queued_at, T0, "the row shows 'stale since' the FIRST edit");
  assertEquals(second.source, "edit", "the first source names the marker");
  assertEquals(second.attempts, 1, "a failing channel is not reset to fresh by a new edit");
  assertEquals(second.last_error, undefined, "the next apply is a new attempt at new values");
});

Deno.test("only a positive applied clears; everything else keeps the listing stale", () => {
  const m = planReviseStamp(null, ["price"], T0, "edit");

  assertEquals(applyReviseOutcome(m, { applied: true }, T1), { cleared: true });

  const unverified = applyReviseOutcome(m, { applied: false, unverified: true }, T1);
  assert(!unverified.cleared);
  assertEquals(unverified.marker.attempts, 1);
  assertEquals(unverified.marker.last_attempt_at, T1);
  assert(unverified.marker.last_error!.includes("could not confirm"));
  assertEquals(unverified.marker.queued_at, T0);

  const manual = applyReviseOutcome(m, { applied: false, manual: true }, T1);
  assert(!manual.cleared);
  assert(manual.marker.last_error!.includes("by hand"));

  const withError = applyReviseOutcome(m, { applied: false, error: "  Poshmark's editor changed  " }, T1);
  assert(!withError.cleared);
  assertEquals(withError.marker.last_error, "Poshmark's editor changed");

  // `applied` must be literally true. A truthy string from a loose client is
  // not confirmation.
  const loose = applyReviseOutcome(m, { applied: "yes" as unknown as boolean }, T1);
  assert(!loose.cleared, "a non-boolean applied must not clear the marker");
});

Deno.test("auto-revisable needs a confirmed-live listing, a URL and attempts left", () => {
  const fresh: RevisePendingMarker = { fields: ["price"], queued_at: T0, source: "edit", attempts: 0 };
  assert(isAutoRevisable("active", "https://poshmark.com/listing/x", fresh));
  assert(!isAutoRevisable("draft", "https://poshmark.com/listing/x", fresh), "a prefill never seen live");
  assert(!isAutoRevisable("active", null, fresh), "nothing to open");
  assert(!isAutoRevisable("ended", "https://poshmark.com/listing/x", fresh));
  const spent: RevisePendingMarker = { ...fresh, attempts: REVISE_MAX_ATTEMPTS };
  assert(!isAutoRevisable("active", "https://poshmark.com/listing/x", spent), "past the budget it waits for a person");
  const almost: RevisePendingMarker = { ...fresh, attempts: REVISE_MAX_ATTEMPTS - 1 };
  assert(isAutoRevisable("active", "https://poshmark.com/listing/x", almost));
});

Deno.test("attempts count up to the budget one failure at a time", () => {
  let m = planReviseStamp(null, ["title"], T0, "mobile");
  for (let i = 1; i <= REVISE_MAX_ATTEMPTS; i++) {
    const out = applyReviseOutcome(m, { applied: false, unverified: true }, T1);
    assert(!out.cleared);
    m = out.marker;
    assertEquals(m.attempts, i);
  }
  assert(!isAutoRevisable("active", "https://www.mercari.com/item/m1", m));
  // A person can still clear it by getting the marketplace to confirm.
  assertEquals(applyReviseOutcome(m, { applied: true }, T2), { cleared: true });
});
