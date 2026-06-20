import { assert, assertEquals } from "@std/assert";
import {
  aggregateEngagement,
  computeWeights,
  DEFAULT_TUNING_CONFIG,
  type EngagementCount,
  NEWSLETTER_TOPICS,
  recommendSendHour,
  selectWeightedKey,
  SUBJECT_STYLES,
  topicByPillarAngle,
} from "../lib/newsletter-tuning.ts";

// US-928: the self-tuning weighting is pure — no supabase/env — so it tests
// directly (mirrors drip-optimizer_test.ts).

function ec(over: Partial<EngagementCount> = {}): EngagementCount {
  return { sent: 0, opened: 0, clicked: 0, unsubscribed: 0, ...over };
}

const CFG = { ...DEFAULT_TUNING_CONFIG, minSample: 50, explorationFloor: 0.15, unsubCeiling: 0.005 };

// ── AC6: a high-unsub topic is down-weighted (paused) in the next selection ──
Deno.test("a topic with a high unsubscribe rate is paused (down-weighted to 0)", () => {
  const keys = ["good", "spammy", "fresh"];
  const counts = {
    // Healthy engager, low unsub.
    good: ec({ sent: 400, opened: 200, clicked: 60, unsubscribed: 1 }),
    // High unsub rate (10/500 = 2% ≫ 0.5% ceiling), enough sample → paused.
    spammy: ec({ sent: 500, opened: 220, clicked: 90, unsubscribed: 10 }),
    // Under-tested — must still earn exploration airtime.
    fresh: ec({ sent: 5, opened: 3, clicked: 1, unsubscribed: 0 }),
  };
  const res = computeWeights(keys, counts, CFG);

  // The spammy topic is paused with zero weight.
  assert(res.paused.includes("spammy"));
  assertEquals(res.weights.spammy, 0);
  // It is strictly down-weighted relative to the healthy topic.
  assert(res.weights.good > res.weights.spammy);
  // Guardrail: the under-tested topic still gets airtime (exploration floor).
  assert((res.weights.fresh ?? 0) > 0, "under-tested topic must keep exploration airtime");
  // Weights are a valid distribution summing to 100.
  assertEquals(Object.values(res.weights).reduce((a, b) => a + b, 0), 100);
});

Deno.test("the winner (best CTR among trusted) takes the bulk of the weight", () => {
  const keys = ["a", "b"];
  const counts = {
    a: ec({ sent: 300, opened: 150, clicked: 30, unsubscribed: 0 }), // 10% CTR
    b: ec({ sent: 300, opened: 150, clicked: 75, unsubscribed: 0 }), // 25% CTR → winner
  };
  const res = computeWeights(keys, counts, CFG);
  assertEquals(res.winnerKey, "b");
  assert(res.weights.b > res.weights.a);
  // Winner gets ~(1-floor) + its floor share; loser only the floor share.
  assert(res.weights.b >= 80);
});

Deno.test("CTR beats open rate (newsletter goal is the click-through)", () => {
  const keys = ["opener", "clicker"];
  const counts = {
    opener: ec({ sent: 200, opened: 180, clicked: 10 }), // high opens, low clicks
    clicker: ec({ sent: 200, opened: 90, clicked: 50 }), // fewer opens, more clicks
  };
  const res = computeWeights(keys, counts, CFG);
  assertEquals(res.winnerKey, "clicker");
});

Deno.test("below the sample threshold there is no winner → uniform exploration", () => {
  const keys = ["x", "y", "z"];
  const counts = {
    x: ec({ sent: 10, clicked: 9 }), // great rate but tiny sample
    y: ec({ sent: 5, clicked: 0 }),
    z: ec({ sent: 0 }),
  };
  const res = computeWeights(keys, counts, CFG);
  assertEquals(res.winnerKey, null);
  assert(!res.hasEnoughData);
  // Uniform (33/33/34) — no premature convergence.
  for (const w of Object.values(res.weights)) assert(w >= 33 && w <= 34);
});

Deno.test("never pauses the last surviving topic even if all breach the ceiling", () => {
  const keys = ["a", "b"];
  const counts = {
    a: ec({ sent: 200, clicked: 20, unsubscribed: 8 }), // 4% unsub
    b: ec({ sent: 200, clicked: 20, unsubscribed: 4 }), // 2% unsub (lower)
  };
  const res = computeWeights(keys, counts, CFG);
  // Both breach, but the lower-unsub one stays sendable.
  assertEquals(res.paused, ["a"]);
  assert(res.weights.b > 0);
  assertEquals(Object.values(res.weights).reduce((s, v) => s + v, 0), 100);
});

Deno.test("selectWeightedKey never picks a zero-weight (paused) key and is deterministic", () => {
  const weights = { good: 85, spammy: 0, fresh: 15 };
  const picks = new Set<string>();
  for (let i = 0; i < 200; i++) picks.add(selectWeightedKey(weights, `seed-${i}`)!);
  assert(!picks.has("spammy"), "a paused (0-weight) key must never be selected");
  assert(picks.has("good") && picks.has("fresh"));
  // Same seed → same key.
  assertEquals(selectWeightedKey(weights, "stable"), selectWeightedKey(weights, "stable"));
  // All-zero → null.
  assertEquals(selectWeightedKey({ a: 0, b: 0 }, "x"), null);
});

Deno.test("recommendSendHour picks the best-CTR trusted hour, else null", () => {
  const byHour = {
    9: ec({ sent: 100, opened: 40, clicked: 8 }), // 8% CTR
    14: ec({ sent: 100, opened: 50, clicked: 20 }), // 20% CTR → best
    20: ec({ sent: 3, opened: 3, clicked: 3 }), // 100% CTR but tiny sample
  };
  assertEquals(recommendSendHour(byHour, CFG).bestHour, 14);
  // No hour with enough data → no recommendation.
  assertEquals(recommendSendHour({ 6: ec({ sent: 10, clicked: 9 }) }, CFG).bestHour, null);
});

Deno.test("aggregateEngagement folds ledger rows into per-key counts; click implies open", () => {
  const rows = [
    { topic: "a", opened: true, clicked: false, unsub: false },
    { topic: "a", opened: false, clicked: true, unsub: false },
    { topic: "b", opened: false, clicked: false, unsub: true },
    { topic: null, opened: true, clicked: true, unsub: false }, // skipped (no key)
  ];
  const counts = aggregateEngagement(
    rows,
    (r) => r.topic,
    (r) => ({ opened: r.opened || r.clicked, clicked: r.clicked, unsubscribed: r.unsub }),
  );
  assertEquals(counts.a, { sent: 2, opened: 2, clicked: 1, unsubscribed: 0 });
  assertEquals(counts.b, { sent: 1, opened: 0, clicked: 0, unsubscribed: 1 });
  assertEquals(Object.keys(counts).length, 2);
});

Deno.test("catalog: every topic has a unique (pillar, angle) and resolves back", () => {
  const seen = new Set<string>();
  for (const t of NEWSLETTER_TOPICS) {
    const k = `${t.pillar}::${t.angle}`;
    assert(!seen.has(k), `duplicate pillar/angle ${k}`);
    seen.add(k);
    assertEquals(topicByPillarAngle(t.pillar, t.angle)?.id, t.id);
  }
  assert(SUBJECT_STYLES.length >= 3);
});
