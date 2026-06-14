// US-889: cross-tenant listing & photo moderation — unit coverage for the
// reversible-takedown contract and the reusable flag-queue helpers.
//
// The cross-tenant READ path (the moderation endpoints can read any tenant by
// design) and the audited WRITE paths are driven end-to-end by the env-gated
// integration suite (tenant-isolation_test.ts) against a running edge service.
// These pure tests lock the invariant that every takedown is REVERSIBLE — each
// `*Patch` has an exact inverse `*RestorePatch` — and that the flag dedupe key
// is stable, so a flag enqueued twice collapses to one open row.

import { assertEquals } from "@std/assert";

// moderation-queue.ts transitively imports the service-role supabase client,
// which throws at load without env — set dummy env BEFORE the dynamic import
// (same pattern as abuse-signals_test.ts / schema-version_test.ts).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  flagDedupeKey,
  listingRestorePatch,
  listingTakedownPatch,
  photoHidePatch,
  photoRestorePatch,
} = await import("../lib/moderation-queue.ts");

Deno.test("listing takedown is reversible — restore is its exact inverse", () => {
  const down = listingTakedownPatch();
  const up = listingRestorePatch();

  // Takedown removes the listing from public/marketplace surfaces.
  assertEquals(down, {
    is_active: false,
    listing_status: "ended",
    moderation_hidden: true,
  });
  // Restore flips every field the takedown touched back to a published state.
  assertEquals(up, {
    is_active: true,
    listing_status: "active",
    moderation_hidden: false,
  });
  // The two patches touch the SAME keys (so restore fully reverses takedown).
  assertEquals(Object.keys(down).sort(), Object.keys(up).sort());
  for (const key of Object.keys(down) as Array<keyof typeof down>) {
    // Every field is inverted, not merely re-set to the same value.
    assertEquals(down[key] !== up[key], true, `field ${key} must invert`);
  }
});

Deno.test("photo hide is reversible — unhide is its exact inverse", () => {
  assertEquals(photoHidePatch(), { is_hidden: true });
  assertEquals(photoRestorePatch(), { is_hidden: false });
  assertEquals(
    photoHidePatch().is_hidden !== photoRestorePatch().is_hidden,
    true,
  );
});

Deno.test("flag dedupe key is stable + scoped by content type", () => {
  assertEquals(flagDedupeKey("listing", "abc"), "listing:abc");
  assertEquals(flagDedupeKey("photo", "abc"), "photo:abc");
  // Same id, different type → different key (a listing and a photo never collide).
  assertEquals(
    flagDedupeKey("listing", "abc") === flagDedupeKey("photo", "abc"),
    false,
  );
  // Deterministic: the same inputs always produce the same key, so a re-enqueue
  // maps to the one open flag.
  assertEquals(flagDedupeKey("listing", "x"), flagDedupeKey("listing", "x"));
});
