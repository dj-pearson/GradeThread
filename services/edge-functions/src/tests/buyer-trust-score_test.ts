// US-1816: buyer Trust Score engine — the deterministic, event-sourced scoring
// math (points, decay, penalties, tenure cap, level thresholds, anti-gaming).
import { assert, assertEquals } from "@std/assert";
import type { ReputationEventType } from "../lib/buyer-trust-score.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  computeTrustScore,
  levelForScore,
  REPUTATION_POINTS,
  MAX_TENURE_POINTS,
  TRUST_LEVELS,
} = await import("../lib/buyer-trust-score.ts");

type Ev = { eventType: ReputationEventType; occurredAt: string; verified: boolean };

const NOW = Date.UTC(2026, 6, 9); // fixed clock so decay is deterministic
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function ev(eventType: ReputationEventType, opts: Partial<Ev> = {}): Ev {
  return { eventType, occurredAt: opts.occurredAt ?? daysAgo(0), verified: opts.verified ?? true };
}

Deno.test("empty log → zeroed 'new' buyer", () => {
  const r = computeTrustScore([], NOW);
  assertEquals(r.score, 0);
  assertEquals(r.level, 0);
  assertEquals(r.levelLabel, "new");
  assertEquals(r.totalEventCount, 0);
  assertEquals(r.scoredEventCount, 0);
});

Deno.test("anti-gaming: unverified events never score", () => {
  const r = computeTrustScore(
    [ev("grade_confirmed", { verified: false }), ev("verified_purchase", { verified: false })],
    NOW,
  );
  assertEquals(r.score, 0);
  assertEquals(r.scoredEventCount, 0);
  assertEquals(r.totalEventCount, 2); // still counted as seen
});

Deno.test("a fresh event scores its full base points (no decay at age 0)", () => {
  const r = computeTrustScore([ev("grade_confirmed")], NOW);
  assertEquals(r.score, REPUTATION_POINTS.grade_confirmed); // 30
  assertEquals(r.scoredEventCount, 1);
});

Deno.test("positives decay with age (older = less)", () => {
  const fresh = computeTrustScore([ev("grade_confirmed", { occurredAt: daysAgo(0) })], NOW).score;
  const old = computeTrustScore([ev("grade_confirmed", { occurredAt: daysAgo(540) })], NOW).score;
  assert(old < fresh, `expected decayed ${old} < fresh ${fresh}`);
  // 540d == one positive half-life → ~half the points.
  assertEquals(old, Math.round(REPUTATION_POINTS.grade_confirmed * 0.5)); // 15
});

Deno.test("penalties suppress the score and floor it at 0 (never negative)", () => {
  const r = computeTrustScore([ev("verified_purchase"), ev("chargeback_penalty")], NOW);
  // +8 purchase, -50 chargeback → raw negative, floored to 0.
  assertEquals(r.score, 0);
  assert(r.penaltyPoints > r.positivePoints);
});

Deno.test("penalties decay slower than positives (abuse sticks)", () => {
  // Equal-magnitude positive vs penalty, both 1460d old (one penalty half-life).
  const pos = computeTrustScore([ev("chargeback_penalty", { occurredAt: daysAgo(1460) })], NOW);
  // At 1460d the penalty is at half its base; a positive of the same age would be
  // far more decayed (1460/540 half-lives). Confirm the penalty still bites hard.
  assertEquals(pos.penaltyPoints, Math.round(50 * 0.5 * 100) / 100); // 25
});

Deno.test("tenure accumulates but is capped, and does not decay", () => {
  // 40 monthly tenure ticks spread across years → base 80, capped at 48.
  const ticks = Array.from({ length: 40 }, (_, i) => ev("tenure", { occurredAt: daysAgo(i * 30) }));
  const r = computeTrustScore(ticks, NOW);
  assertEquals(r.score, MAX_TENURE_POINTS); // 48, regardless of age spread
});

Deno.test("levelForScore honors every threshold boundary", () => {
  assertEquals(levelForScore(0), { level: 0, label: "new" });
  assertEquals(levelForScore(39), { level: 0, label: "new" });
  assertEquals(levelForScore(40), { level: 1, label: "trusted" });
  assertEquals(levelForScore(119), { level: 1, label: "trusted" });
  assertEquals(levelForScore(120), { level: 2, label: "established" });
  assertEquals(levelForScore(299), { level: 2, label: "established" });
  assertEquals(levelForScore(300), { level: 3, label: "connoisseur" });
  assertEquals(levelForScore(10_000), { level: 3, label: "connoisseur" });
});

Deno.test("a strong recent history reaches a high level", () => {
  const events = [
    ...Array.from({ length: 8 }, () => ev("grade_confirmed")), // 8*30 = 240
    ...Array.from({ length: 10 }, () => ev("verified_purchase")), // 10*8 = 80
  ];
  const r = computeTrustScore(events, NOW);
  assertEquals(r.score, 320);
  assertEquals(r.levelLabel, "connoisseur");
});

Deno.test("deterministic: identical inputs yield identical output", () => {
  const events = [ev("grade_confirmed", { occurredAt: daysAgo(100) }), ev("dispute_upheld")];
  const a = computeTrustScore(events, NOW);
  const b = computeTrustScore(events, NOW);
  assertEquals(a, b);
});

Deno.test("an upheld dispute is a small positive, an overturned one a penalty", () => {
  const upheld = computeTrustScore([ev("dispute_upheld")], NOW);
  const overturned = computeTrustScore([ev("dispute_overturned")], NOW);
  assertEquals(upheld.score, REPUTATION_POINTS.dispute_upheld); // +3
  assertEquals(overturned.score, 0); // -20 floored
  assert(overturned.penaltyPoints > 0);
});

Deno.test("TRUST_LEVELS is ordered and starts at 0", () => {
  assertEquals(TRUST_LEVELS[0].min, 0);
  for (let i = 1; i < TRUST_LEVELS.length; i++) {
    assert(TRUST_LEVELS[i].min > TRUST_LEVELS[i - 1].min);
    assertEquals(TRUST_LEVELS[i].level, TRUST_LEVELS[i - 1].level + 1);
  }
});
