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
  CERTIFICATE_REPORT_REASONS,
  composeCertificateReportReason,
  flagDedupeKey,
  isCertificateReportReason,
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

// ── US-2550: buyer reports against a certificate ──────────────────────────

Deno.test("a certificate flag key never collides with a listing or photo", () => {
  assertEquals(flagDedupeKey("certificate", "abc"), "certificate:abc");
  assertEquals(
    flagDedupeKey("certificate", "abc") === flagDedupeKey("listing", "abc"),
    false,
  );
});

Deno.test("only the published reasons are accepted", () => {
  // The client offers exactly these keys. Anything else is a caller sending
  // free text into an operator queue.
  for (const key of Object.keys(CERTIFICATE_REPORT_REASONS)) {
    assertEquals(isCertificateReportReason(key), true, key);
  }
  assertEquals(isCertificateReportReason("scam"), false);
  assertEquals(isCertificateReportReason(""), false);
  assertEquals(isCertificateReportReason(null), false);
  assertEquals(isCertificateReportReason(42), false);
  // Prototype keys are not report reasons.
  assertEquals(isCertificateReportReason("toString"), false);
});

Deno.test("repeat reports COUNT rather than overwrite each other", () => {
  // The queue keeps ONE open flag per certificate (partial unique index), so
  // without carrying the count in the reason the fifth reporter would silently
  // replace the first and five independent complaints would read as one.
  const first = composeCertificateReportReason(
    null,
    CERTIFICATE_REPORT_REASONS.altered,
    null,
  );
  assertEquals(first.startsWith("1 buyer report."), true, first);

  const second = composeCertificateReportReason(
    first,
    CERTIFICATE_REPORT_REASONS.stolen,
    null,
  );
  assertEquals(second.startsWith("2 buyer reports."), true, second);

  const third = composeCertificateReportReason(
    second,
    CERTIFICATE_REPORT_REASONS.other,
    null,
  );
  assertEquals(third.startsWith("3 buyer reports."), true, third);
  // The LATEST reason is what an operator reads first.
  assertEquals(third.includes(CERTIFICATE_REPORT_REASONS.other), true);
});

Deno.test("a note is normalised and capped", () => {
  const messy = composeCertificateReportReason(
    null,
    CERTIFICATE_REPORT_REASONS.other,
    "  it   arrived\n\nwith a different tag  ",
  );
  assertEquals(messy.includes("Note: it arrived with a different tag"), true, messy);

  const long = composeCertificateReportReason(
    null,
    CERTIFICATE_REPORT_REASONS.other,
    "x".repeat(5000),
  );
  // 500 is the cap the client also enforces; the server does not trust it.
  assertEquals(long.includes("x".repeat(500)), true);
  assertEquals(long.includes("x".repeat(501)), false);
});

Deno.test("an unparseable existing reason restarts the count at 1", () => {
  // An operator may have rewritten the reason by hand. Better to under-count
  // than to throw away the report.
  const out = composeCertificateReportReason(
    "looks forged, escalating",
    CERTIFICATE_REPORT_REASONS.altered,
    null,
  );
  assertEquals(out.startsWith("1 buyer report."), true, out);
});

