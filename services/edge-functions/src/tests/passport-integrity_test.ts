// US-1103: Garment Passport integrity detectors. Pure — no DB, no clock.
//
// Covers each anomaly builder + the operator-safety evidence guard (no image
// bytes / URLs / PII ever cross into a signal an admin sees).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertSafePassportEvidence,
  buildDuplicateFingerprintSignals,
  buildRapidReclaimSignals,
  buildTokenReplaySignals,
  buildWearReversalSignals,
  duplicateFingerprintDedupeKey,
  type FingerprintRow,
} from "../lib/passport-integrity.ts";

// 16-hex dHash vectors: A and A1 are 1 bit apart (a collision); FAR is opposite.
const H_A = "0000000000000000";
const H_A1 = "0000000000000001";
const H_FAR = "ffffffffffffffff";

// ── evidence safety ───────────────────────────────────────────────────────────

Deno.test("assertSafePassportEvidence: allow-listed fact passes", () => {
  assertSafePassportEvidence({ reclaim_count: 5, window_hours: 72, since: "2026-06-19" });
  assertSafePassportEvidence({
    counterpart_garment_id: "g2",
    owner_node_id: "n1",
    counterpart_owner_node_id: "n2",
    matches: [{ image_type: "front", phash: H_A, distance: 1, counterpart_image_type: "front" }],
  });
});

Deno.test("assertSafePassportEvidence: rejects non-allow-listed key", () => {
  assertThrows(() => assertSafePassportEvidence({ secret_email: "a@b.com" }), Error, "not allow-listed");
});

Deno.test("assertSafePassportEvidence: rejects image bytes / URLs / emails in values", () => {
  assertThrows(() => assertSafePassportEvidence({ token_hash: "https://x/storage/p.jpg" }), Error);
  assertThrows(() => assertSafePassportEvidence({ token_hash: "data:image/png;base64,AAAA" }), Error);
  assertThrows(() => assertSafePassportEvidence({ since: "user@example.com" }), Error);
});

Deno.test("assertSafePassportEvidence: rejects bad match key", () => {
  assertThrows(
    () => assertSafePassportEvidence({ matches: [{ subject_image_id: "x" }] }),
    Error,
    "match key",
  );
});

// ── wear reversal (condition improved across a same-item link) ────────────────

function fp(id: string, garment: string, wear: number, at: string): FingerprintRow {
  return { id, garment_id: garment, grade_report_id: `gr-${id}`, wear_score: wear, created_at: at };
}

Deno.test("wear reversal: a materially LOWER later wear score flags", () => {
  // Worn to 5.0, then a later sighting at 2.0 — condition "improved" by 3 points.
  const rows = [fp("a", "G", 5.0, "2026-01-01"), fp("b", "G", 2.0, "2026-02-01")];
  const out = buildWearReversalSignals(rows);
  assertEquals(out.length, 1);
  assertEquals(out[0].signal_type, "wear_reversal");
  assertEquals(out[0].garment_id, "G");
  assertEquals(out[0].evidence.drop, 3);
  assertEquals(out[0].severity, "high"); // 3 ∈ [2.5,4)
  assertEquals(out[0].evidence.from_event_id, "a");
  assertEquals(out[0].evidence.to_event_id, "b");
});

Deno.test("wear reversal: grading noise within tolerance does NOT flag", () => {
  const rows = [fp("a", "G", 5.0, "2026-01-01"), fp("b", "G", 4.5, "2026-02-01")];
  assertEquals(buildWearReversalSignals(rows).length, 0);
});

Deno.test("wear reversal: monotonic increase (normal wear) does NOT flag", () => {
  const rows = [fp("a", "G", 3.0, "2026-01-01"), fp("b", "G", 6.0, "2026-02-01")];
  assertEquals(buildWearReversalSignals(rows).length, 0);
});

Deno.test("wear reversal: unsorted input is ordered by time; severity scales", () => {
  // Newest-first input; a 5-point reversal → critical.
  const rows = [fp("b", "G", 1.0, "2026-03-01"), fp("a", "G", 6.0, "2026-01-01")];
  const out = buildWearReversalSignals(rows);
  assertEquals(out.length, 1);
  assertEquals(out[0].evidence.drop, 5);
  assertEquals(out[0].severity, "critical");
});

// ── duplicate fingerprint across active owners ────────────────────────────────

Deno.test("duplicate fingerprint: same hash, DIFFERENT owners flags", () => {
  const out = buildDuplicateFingerprintSignals([
    { garment_id: "G1", owner_node_id: "owner-A", phashes: { front: H_A } },
    { garment_id: "G2", owner_node_id: "owner-B", phashes: { front: H_A1 } },
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].signal_type, "duplicate_fingerprint");
  // Subject = lexicographically-smaller garment id; counterpart in evidence.
  assertEquals(out[0].garment_id, "G1");
  assertEquals(out[0].evidence.counterpart_garment_id, "G2");
  assertEquals(out[0].dedupe_key, duplicateFingerprintDedupeKey("G1", "G2"));
});

Deno.test("duplicate fingerprint: SAME owner relisting is NOT an anomaly", () => {
  const out = buildDuplicateFingerprintSignals([
    { garment_id: "G1", owner_node_id: "owner-A", phashes: { front: H_A } },
    { garment_id: "G2", owner_node_id: "owner-A", phashes: { front: H_A1 } },
  ]);
  assertEquals(out.length, 0);
});

Deno.test("duplicate fingerprint: visually different garments do NOT collide", () => {
  const out = buildDuplicateFingerprintSignals([
    { garment_id: "G1", owner_node_id: "owner-A", phashes: { front: H_A } },
    { garment_id: "G2", owner_node_id: "owner-B", phashes: { front: H_FAR } },
  ]);
  assertEquals(out.length, 0);
});

Deno.test("duplicate fingerprint: a missing current owner never flags", () => {
  const out = buildDuplicateFingerprintSignals([
    { garment_id: "G1", owner_node_id: null, phashes: { front: H_A } },
    { garment_id: "G2", owner_node_id: "owner-B", phashes: { front: H_A1 } },
  ]);
  assertEquals(out.length, 0);
});

// ── rapid re-claim ────────────────────────────────────────────────────────────

Deno.test("rapid re-claim: counts only successful claims, applies threshold", () => {
  const attempts = [
    { garment_id: "G", token_hash: "t1", outcome: "claimed" as const, created_at: "2026-06-01" },
    { garment_id: "G", token_hash: "t2", outcome: "claimed" as const, created_at: "2026-06-02" },
    { garment_id: "G", token_hash: "t3", outcome: "claimed" as const, created_at: "2026-06-03" },
    { garment_id: "G", token_hash: "t4", outcome: "rejected" as const, created_at: "2026-06-03" },
  ];
  const out = buildRapidReclaimSignals(attempts, {
    threshold: 3,
    sinceIso: "2026-06-01T00:00:00Z",
    windowHours: 72,
  });
  assertEquals(out.length, 1);
  assertEquals(out[0].signal_type, "rapid_reclaim");
  assertEquals(out[0].evidence.reclaim_count, 3); // rejected one not counted
  assertEquals(out[0].garment_id, "G");
});

Deno.test("rapid re-claim: below threshold does NOT flag", () => {
  const attempts = [
    { garment_id: "G", token_hash: "t1", outcome: "claimed" as const, created_at: "2026-06-01" },
    { garment_id: "G", token_hash: "t2", outcome: "claimed" as const, created_at: "2026-06-02" },
  ];
  assertEquals(
    buildRapidReclaimSignals(attempts, { threshold: 3, sinceIso: "2026-06-01", windowHours: 72 }).length,
    0,
  );
});

// ── token replay ──────────────────────────────────────────────────────────────

Deno.test("token replay: rejected attempts on a known token flag", () => {
  const attempts = [
    { garment_id: "G", token_hash: "deadbeefcafef00d", outcome: "rejected" as const, created_at: "2026-06-01" },
    { garment_id: "G", token_hash: "deadbeefcafef00d", outcome: "rejected" as const, created_at: "2026-06-01" },
    { garment_id: "G", token_hash: "deadbeefcafef00d", outcome: "rejected" as const, created_at: "2026-06-01" },
  ];
  const out = buildTokenReplaySignals(attempts, {
    threshold: 3,
    sinceIso: "2026-06-01T00:00:00Z",
    windowHours: 72,
  });
  assertEquals(out.length, 1);
  assertEquals(out[0].signal_type, "token_replay");
  assertEquals(out[0].evidence.rejected_count, 3);
  assertEquals(out[0].evidence.token_hash, "deadbeefcafef00d");
  assert((out[0].evidence.attempt_count as number) >= 3);
});

Deno.test("token replay: a single rejection (a fat-finger) does NOT flag", () => {
  const attempts = [
    { garment_id: "G", token_hash: "abc123", outcome: "rejected" as const, created_at: "2026-06-01" },
  ];
  assertEquals(
    buildTokenReplaySignals(attempts, { threshold: 3, sinceIso: "2026-06-01", windowHours: 72 }).length,
    0,
  );
});
