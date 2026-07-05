// US-1597: Trust & Safety agent pure domain logic — severity ranking, ring
// detection, and the assembled memo. No env/DB (pure module).
import { assert, assertEquals } from "@std/assert";
import {
  type AbuseSignal,
  assembleTrustSafetyMemo,
  detectRings,
  rankAbuseSignals,
} from "../lib/trust-safety-agent.ts";

const NOW = Date.parse("2026-07-05T00:00:00.000Z");
const ago = (d: number) => new Date(NOW - d * 86400_000).toISOString();

function sig(over: Partial<AbuseSignal>): AbuseSignal {
  return { id: "s", signal_type: "submission_velocity", severity: "low", subject_user_id: "u", evidence: {}, first_seen_at: ago(1), ...over };
}

// ── Severity ranking ─────────────────────────────────────────────────────────

Deno.test("rankAbuseSignals: severity dominates, age breaks ties", () => {
  const ranked = rankAbuseSignals([
    sig({ id: "low_old", severity: "low", first_seen_at: ago(30) }),
    sig({ id: "crit_new", severity: "critical", first_seen_at: ago(1) }),
    sig({ id: "high_new", severity: "high", first_seen_at: ago(1) }),
  ], NOW);
  assertEquals(ranked.map((r) => r.id), ["crit_new", "high_new", "low_old"]);
  assert(ranked[0].rationale.includes("critical"));
});

Deno.test("rankAbuseSignals: same severity → older first", () => {
  const ranked = rankAbuseSignals([
    sig({ id: "new", severity: "high", first_seen_at: ago(1) }),
    sig({ id: "old", severity: "high", first_seen_at: ago(10) }),
  ], NOW);
  assertEquals(ranked[0].id, "old");
  assertEquals(ranked[0].age_days, 10);
});

// ── Ring detection ───────────────────────────────────────────────────────────

Deno.test("detectRings: shared payment across accounts is a ring with all account ids", () => {
  const rings = detectRings([
    sig({ signal_type: "shared_payment", subject_user_id: "uA", evidence: { stripe_customer_id: "cus_9", account_user_ids: ["uB", "uC"] } }),
  ]);
  assertEquals(rings.length, 1);
  assertEquals(rings[0].ring_key, "payment:cus_9");
  assertEquals(rings[0].account_count, 3);
  assertEquals(rings[0].accounts, ["uA", "uB", "uC"]);
});

Deno.test("detectRings: disposable-email accounts accumulate across signals sharing the domain", () => {
  const rings = detectRings([
    sig({ signal_type: "disposable_email", subject_user_id: "u1", evidence: { email_domain: "temp.io" } }),
    sig({ signal_type: "disposable_email", subject_user_id: "u2", evidence: { email_domain: "temp.io" } }),
    sig({ signal_type: "disposable_email", subject_user_id: "u3", evidence: { email_domain: "other.io" } }),
  ]);
  assertEquals(rings.length, 1); // temp.io has 2 accounts; other.io has 1 (not a ring)
  assertEquals(rings[0].ring_key, "email_domain:temp.io");
  assertEquals(rings[0].accounts, ["u1", "u2"]);
});

Deno.test("detectRings: single-account signal types contribute no ring", () => {
  const rings = detectRings([
    sig({ signal_type: "submission_velocity", subject_user_id: "u1", evidence: { count: 50 } }),
    sig({ signal_type: "phash_collision", subject_user_id: "u1", evidence: { phash: "abc" } }), // no counterpart → 1 account
  ]);
  assertEquals(rings.length, 0);
});

// ── Memo ─────────────────────────────────────────────────────────────────────

Deno.test("assembleTrustSafetyMemo: all-clear when every queue is empty", () => {
  const memo = assembleTrustSafetyMemo({ abuseSignals: [], openModerationFlags: 0, openPassportIntegritySignals: 0, nowMs: NOW });
  assertEquals(memo.all_clear, true);
});

Deno.test("assembleTrustSafetyMemo: signals + ring + moderation break all-clear", () => {
  const memo = assembleTrustSafetyMemo({
    abuseSignals: [
      sig({ id: "s1", signal_type: "shared_payment", severity: "critical", subject_user_id: "uA", evidence: { stripe_customer_id: "c", account_user_ids: ["uB"] } }),
    ],
    openModerationFlags: 4,
    openPassportIntegritySignals: 1,
    nowMs: NOW,
  });
  assertEquals(memo.all_clear, false);
  assertEquals(memo.ranked_queue.length, 1);
  assertEquals(memo.rings.length, 1);
  assertEquals(memo.moderation_open, 4);
  assertEquals(memo.passport_integrity_open, 1);
});
