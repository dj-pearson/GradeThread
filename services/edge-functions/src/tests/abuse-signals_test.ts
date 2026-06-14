// US-888: pure abuse-signal derivation + the evidence-safety invariant.
//
// abuse-signals.ts transitively imports the service-role supabase client (via
// photo-reuse.ts) which throws at load without env, so set dummy env BEFORE the
// dynamic import (same pattern as photo-reuse_test.ts / schema-version_test.ts).
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { PhashImageRow } from "../lib/abuse-signals.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  assertSafeEvidence,
  buildPhashCollisionSignals,
  buildVelocitySignals,
  phashCollisionDedupeKey,
  velocityDedupeKey,
} = await import("../lib/abuse-signals.ts");

function img(over: Partial<PhashImageRow> & { image_id: string; user_id: string; phash: string }): PhashImageRow {
  return {
    submission_id: `sub-${over.image_id}`,
    image_type: "front",
    created_at: "2026-06-14T00:00:00Z",
    ...over,
  };
}

// ── phash collision ──────────────────────────────────────────────────────────

Deno.test("phash: identical photo across DIFFERENT accounts is a signal", () => {
  const hash = "ffffffffffffffff";
  const rows = [
    img({ image_id: "a1", user_id: "userA", phash: hash, created_at: "2026-06-10T00:00:00Z" }),
    img({ image_id: "b1", user_id: "userB", phash: hash, created_at: "2026-06-14T00:00:00Z" }),
  ];
  const signals = buildPhashCollisionSignals(rows);
  assertEquals(signals.length, 1);
  const s = signals[0]!;
  assertEquals(s.signal_type, "phash_collision");
  // Subject = the NEWER submitter (the reuser): userB.
  assertEquals(s.subject_user_id, "userB");
  assertEquals(s.evidence.counterpart_user_id, "userA");
  assertEquals(s.evidence.reused_count, 1);
  assertEquals(s.dedupe_key, phashCollisionDedupeKey("userA", "userB"));
});

Deno.test("phash: same-account relist is NOT a signal", () => {
  const hash = "abcdef0123456789";
  const rows = [
    img({ image_id: "a1", user_id: "userA", phash: hash }),
    img({ image_id: "a2", user_id: "userA", phash: hash }),
  ];
  assertEquals(buildPhashCollisionSignals(rows).length, 0);
});

Deno.test("phash: distant hashes do not collide", () => {
  const rows = [
    img({ image_id: "a1", user_id: "userA", phash: "0000000000000000" }),
    img({ image_id: "b1", user_id: "userB", phash: "ffffffffffffffff" }),
  ];
  assertEquals(buildPhashCollisionSignals(rows).length, 0);
});

Deno.test("phash: multiple reused photos between a pair aggregate + raise severity", () => {
  const rows = [
    img({ image_id: "a1", user_id: "userA", phash: "1111111111111111", created_at: "2026-06-01T00:00:00Z" }),
    img({ image_id: "a2", user_id: "userA", phash: "2222222222222222", created_at: "2026-06-01T00:00:00Z" }),
    img({ image_id: "b1", user_id: "userB", phash: "1111111111111111", created_at: "2026-06-14T00:00:00Z" }),
    img({ image_id: "b2", user_id: "userB", phash: "2222222222222222", created_at: "2026-06-14T00:00:00Z" }),
  ];
  const signals = buildPhashCollisionSignals(rows);
  assertEquals(signals.length, 1);
  assertEquals(signals[0]!.evidence.reused_count, 2);
  assertEquals(signals[0]!.severity, "high");
});

Deno.test("phash: dedupe key is direction-independent + scan is idempotent", () => {
  assertEquals(
    phashCollisionDedupeKey("userA", "userB"),
    phashCollisionDedupeKey("userB", "userA"),
  );
});

Deno.test("phash: malformed hashes are ignored, never a false positive", () => {
  const rows = [
    img({ image_id: "a1", user_id: "userA", phash: "not-a-hash" }),
    img({ image_id: "b1", user_id: "userB", phash: "" }),
  ];
  assertEquals(buildPhashCollisionSignals(rows).length, 0);
});

// ── evidence safety (AC4: never leak image bytes across tenants) ──────────────

Deno.test("evidence: a built phash signal carries only ids/hash/distance — no image bytes", () => {
  const hash = "ffffffffffffffff";
  const rows = [
    img({ image_id: "a1", user_id: "userA", phash: hash, created_at: "2026-06-10T00:00:00Z" }),
    img({ image_id: "b1", user_id: "userB", phash: hash, created_at: "2026-06-14T00:00:00Z" }),
  ];
  const ev = buildPhashCollisionSignals(rows)[0]!.evidence;
  // Must not throw — the builder only emits allow-listed keys.
  assertSafeEvidence(ev);
  const match = (ev.matches as Array<Record<string, unknown>>)[0]!;
  assert(!("url" in match) && !("image_url" in match) && !("bytes" in match));
});

Deno.test("evidence: assertSafeEvidence rejects a smuggled image URL", () => {
  assertThrows(() =>
    assertSafeEvidence({
      counterpart_user_id: "userA",
      matches: [{
        subject_image_id: "x",
        // a signed storage URL must never reach an operator's view
        counterpart_image_id: "https://api.gradethread.com/storage/v1/object/sign/submission-images/secret.jpg",
      }],
    })
  );
});

Deno.test("evidence: assertSafeEvidence rejects an un-allow-listed top-level key", () => {
  assertThrows(() => assertSafeEvidence({ raw_photo: "AAAA" }));
});

// ── submission velocity ──────────────────────────────────────────────────────

Deno.test("velocity: a burst over threshold is flagged with the right severity", () => {
  const since = "2026-06-13T12:00:00Z";
  const recent = Array.from({ length: 9 }, () => ({ user_id: "userA", created_at: since }));
  const signals = buildVelocitySignals(recent, { threshold: 8, sinceIso: since, windowHours: 24 });
  assertEquals(signals.length, 1);
  assertEquals(signals[0]!.signal_type, "submission_velocity");
  assertEquals(signals[0]!.evidence.count, 9);
  assertEquals(signals[0]!.severity, "medium");
  assertEquals(signals[0]!.dedupe_key, velocityDedupeKey("userA", since));
});

Deno.test("velocity: under threshold is not flagged", () => {
  const since = "2026-06-13T12:00:00Z";
  const recent = Array.from({ length: 4 }, () => ({ user_id: "userA", created_at: since }));
  assertEquals(buildVelocitySignals(recent, { threshold: 8, sinceIso: since, windowHours: 24 }).length, 0);
});

Deno.test("velocity: dedupe key buckets by UTC day", () => {
  assertEquals(velocityDedupeKey("u", "2026-06-13T23:59:59Z"), "submission_velocity:u:2026-06-13");
});
