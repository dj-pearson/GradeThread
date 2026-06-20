import { assert, assertEquals } from "@std/assert";
import {
  aggregateVariantStats,
  assignVariant,
  hasAbTest,
  isMeasurementWindowElapsed,
  normalizeVariants,
  planHoldout,
  type RecipientSignals,
  selectAbWinner,
  type SubjectVariant,
} from "../lib/newsletter-ab.ts";

// US-927: the A/B selection logic is PURE (no supabase/env) so it tests directly
// (mirrors newsletter-tuning_test.ts).

const VARIANTS: SubjectVariant[] = [
  { id: "a", subject: "Grade your closet in 60 seconds" },
  { id: "b", subject: "Is your thrift haul actually worth it?" },
];

// ── AC5: the higher-performing subject is chosen and sent to the holdout ──────
Deno.test("simulated opens across variants → the better subject wins (open metric)", () => {
  // Simulate the holdout: variant B opens far better than variant A.
  const rows: RecipientSignals[] = [];
  // Variant A: 60 sent, 12 opened (20%).
  for (let i = 0; i < 60; i++) rows.push({ variant: "a", opened: i < 12, clicked: false });
  // Variant B: 60 sent, 36 opened (60%) → should win.
  for (let i = 0; i < 60; i++) rows.push({ variant: "b", opened: i < 36, clicked: false });

  const stats = aggregateVariantStats(VARIANTS, rows);
  const winner = selectAbWinner(VARIANTS, stats, { metric: "open", minSample: 50 });

  assertEquals(winner.winnerId, "b");
  assertEquals(winner.source, "auto");
  assert(winner.trusted, "winner should be a trusted (min-sample) pick");
  // The winning subject the remainder would receive.
  const winningSubject = VARIANTS.find((v) => v.id === winner.winnerId)!.subject;
  assertEquals(winningSubject, "Is your thrift haul actually worth it?");
});

Deno.test("click metric (CTA test) selects the higher click-rate variant", () => {
  const rows: RecipientSignals[] = [];
  // A: high opens, low clicks.
  for (let i = 0; i < 80; i++) rows.push({ variant: "a", opened: i < 40, clicked: i < 4 });
  // B: fewer opens but more clicks → wins on the click metric.
  for (let i = 0; i < 80; i++) rows.push({ variant: "b", opened: i < 30, clicked: i < 24 });

  const stats = aggregateVariantStats(VARIANTS, rows);
  assertEquals(selectAbWinner(VARIANTS, stats, { metric: "open", minSample: 50 }).winnerId, "a");
  assertEquals(selectAbWinner(VARIANTS, stats, { metric: "click", minSample: 50 }).winnerId, "b");
});

// ── AC3: minimum sample size → no spurious winner, fall back to default ───────
Deno.test("below minimum sample → falls back to the default (first) variant", () => {
  const rows: RecipientSignals[] = [
    // Tiny, lopsided sample — B looks better but neither reaches min sample.
    { variant: "a", opened: false, clicked: false },
    { variant: "b", opened: true, clicked: true },
  ];
  const stats = aggregateVariantStats(VARIANTS, rows);
  const winner = selectAbWinner(VARIANTS, stats, { metric: "open", minSample: 50 });
  assertEquals(winner.source, "fallback");
  assertEquals(winner.winnerId, "a"); // default = first variant
  assert(!winner.trusted);
});

Deno.test("a click implies an open in the rollup", () => {
  const rows: RecipientSignals[] = [{ variant: "a", opened: false, clicked: true }];
  const [statA] = aggregateVariantStats(VARIANTS, rows);
  assertEquals(statA!.sent, 1);
  assertEquals(statA!.opened, 1); // click implies open
  assertEquals(statA!.clicked, 1);
});

Deno.test("stale/foreign variant ids are ignored in the rollup", () => {
  const rows: RecipientSignals[] = [
    { variant: "z", opened: true, clicked: true }, // not a real variant
    { variant: null, opened: true, clicked: false },
    { variant: "a", opened: true, clicked: false },
  ];
  const stats = aggregateVariantStats(VARIANTS, rows);
  assertEquals(stats.find((s) => s.variantId === "a")!.sent, 1);
  assertEquals(stats.find((s) => s.variantId === "b")!.sent, 0);
});

// ── Holdout planning ─────────────────────────────────────────────────────────
Deno.test("planHoldout splits the list by the test fraction, keeping a remainder", () => {
  const p = planHoldout(1000, 0.2);
  assertEquals(p.holdoutSize, 200);
  assertEquals(p.remainderSize, 800);
});

Deno.test("planHoldout never starves the remainder, and yields no test on a tiny list", () => {
  // A full-list fraction still leaves ≥1 for the remainder.
  const big = planHoldout(10, 1);
  assertEquals(big.holdoutSize, 9);
  assertEquals(big.remainderSize, 1);
  // 1 recipient → no A/B test (holdout 0, caller does a plain send).
  assertEquals(planHoldout(1, 0.5).holdoutSize, 0);
  assertEquals(planHoldout(0, 0.5).holdoutSize, 0);
});

// ── Variant normalization + assignment ───────────────────────────────────────
Deno.test("normalizeVariants drops empties/dupes, caps at 3, re-keys a/b/c", () => {
  const v = normalizeVariants([
    { subject: "  Hello  " },
    { subject: "hello" }, // case-insensitive dup of the first
    { subject: "" }, // empty dropped
    { subject: "World" },
    { subject: "Third" },
    { subject: "Fourth (over cap)" },
  ]);
  assertEquals(v.map((x) => x.id), ["a", "b", "c"]);
  assertEquals(v.map((x) => x.subject), ["Hello", "World", "Third"]);
});

Deno.test("normalizeVariants falls back to the primary subject (no A/B test)", () => {
  const v = normalizeVariants([], "Only subject");
  assertEquals(v.length, 1);
  assertEquals(hasAbTest(v), false);
  assertEquals(normalizeVariants([], "").length, 0);
});

Deno.test("assignVariant is deterministic and roughly balanced", () => {
  const counts: Record<string, number> = { a: 0, b: 0 };
  for (let i = 0; i < 1000; i++) {
    const v = assignVariant(VARIANTS, `user-${i}@example.com`);
    counts[v.id] = (counts[v.id] ?? 0) + 1;
  }
  // Deterministic: same key → same variant.
  assertEquals(assignVariant(VARIANTS, "user-1@example.com").id, assignVariant(VARIANTS, "user-1@example.com").id);
  // Roughly balanced (each within 35–65% over 1000 draws).
  assert(counts.a! > 350 && counts.a! < 650, `unbalanced a=${counts.a}`);
  assert(counts.b! > 350 && counts.b! < 650, `unbalanced b=${counts.b}`);
});

// ── Measurement window ───────────────────────────────────────────────────────
Deno.test("isMeasurementWindowElapsed respects the configured window", () => {
  const start = "2026-06-20T10:00:00.000Z";
  const startMs = Date.parse(start);
  assert(!isMeasurementWindowElapsed(start, 4, startMs + 3 * 3600_000)); // 3h < 4h
  assert(isMeasurementWindowElapsed(start, 4, startMs + 4 * 3600_000)); // exactly 4h
  assert(!isMeasurementWindowElapsed(null, 4, startMs)); // no start → not elapsed
});
