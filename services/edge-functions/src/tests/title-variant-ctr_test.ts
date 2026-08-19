// US-2676: title variants judged by click-through, and the two guards that stop
// that from being worse than what it replaces.
//
// Guard one is exposure. CTR is a ratio, and a ratio over 20 impressions is
// noise with a decimal point; both labels must clear MIN_VARIANT_IMPRESSIONS
// independently before any comparison is reported.
//
// Guard two is the clickbait case. A title can win the click and lose the sale,
// so the readout names a CTR winner but records whether sell-through agrees.
// Promotion is the caller's decision and must require agreement; reporting is
// not, because a seller wants to see a disagreement, not have it hidden.
//
// All pure: fixture rows in, verdict out. No database, no eBay, no clock.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  MIN_CTR_LIFT,
  MIN_VARIANT_IMPRESSIONS,
  readVariantWinner,
  summarizeCtrByPromptVersion,
  summarizeVariantCtr,
} = await import("../lib/title-variant-ctr.ts");

type Row = Parameters<typeof summarizeVariantCtr>[0][number];

let seq = 0;
function row(over: Partial<Row> = {}): Row {
  seq += 1;
  return {
    listingId: `l-${seq}`,
    activeLabel: "A",
    impressions: 1000,
    views: 50,
    clickThroughRate: 0.05,
    sold: false,
    promptVersion: "listing_gen_v1",
    ...over,
  };
}

// ── pooling ────────────────────────────────────────────────────────────────

Deno.test("CTR is pooled across listings, not averaged across their rates", () => {
  // Averaging the two rates gives (0.5 + 0.01) / 2 = 0.255, which lets a
  // garment seen twice outvote one seen ten thousand times. Pooling gives
  // 101 / 10002, which is the fraction of real people who really clicked.
  const [a] = summarizeVariantCtr([
    row({ activeLabel: "A", impressions: 2, views: 1 }),
    row({ activeLabel: "A", impressions: 10_000, views: 100 }),
  ]);
  assertEquals(a!.impressions, 10_002);
  assertEquals(a!.views, 101);
  assertEquals(a!.clickThroughRate, 101 / 10_002);
});

Deno.test("a label with no impressions reports a null rate, not a zero", () => {
  // Zero would mean "nobody clicked". Null means "nobody looked", which is a
  // different thing to tell a seller.
  const [a] = summarizeVariantCtr([row({ impressions: 0, views: 0 })]);
  assertEquals(a!.clickThroughRate, null);
});

Deno.test("a blank label is counted as A, matching the sell-through summary", () => {
  const out = summarizeVariantCtr([row({ activeLabel: "  " }), row({ activeLabel: "A" })]);
  assertEquals(out.length, 1);
  assertEquals(out[0]!.label, "A");
  assertEquals(out[0]!.listings, 2);
});

Deno.test("negative or non-finite traffic is floored, never subtracted", () => {
  const [a] = summarizeVariantCtr([
    row({ impressions: 1000, views: 50 }),
    row({ impressions: -5, views: Number.NaN }),
  ]);
  assertEquals(a!.impressions, 1000);
  assertEquals(a!.views, 50);
});

Deno.test("the variant list is ordered by LABEL, so it cannot be read as a ranking", () => {
  const out = summarizeVariantCtr([
    row({ activeLabel: "B", impressions: 1000, views: 900 }),
    row({ activeLabel: "A", impressions: 1000, views: 1 }),
  ]);
  assertEquals(out.map((v) => v.label), ["A", "B"]);
});

// ── AC3: the exposure floor ────────────────────────────────────────────────

Deno.test("AC3: one label short of the impression floor returns no winner", () => {
  const verdict = readVariantWinner([
    // A is far past the floor and clicking well.
    row({ activeLabel: "A", impressions: MIN_VARIANT_IMPRESSIONS * 10, views: 900 }),
    // B has barely been seen, and its rate looks spectacular because of it.
    row({ activeLabel: "B", impressions: MIN_VARIANT_IMPRESSIONS - 1, views: 150 }),
  ]);
  assertEquals(verdict.state, "not_enough_exposure");
  assert(verdict.state === "not_enough_exposure");
  assertEquals(verdict.short, ["B"]);
  assertEquals(verdict.minImpressions, MIN_VARIANT_IMPRESSIONS);
  // The numbers are still returned: not enough to decide is not nothing to show.
  assertEquals(verdict.variants.length, 2);
});

Deno.test("AC3: exactly at the floor is enough, so the constant means what it says", () => {
  const verdict = readVariantWinner([
    row({ activeLabel: "A", impressions: MIN_VARIANT_IMPRESSIONS, views: 100 }),
    row({ activeLabel: "B", impressions: MIN_VARIANT_IMPRESSIONS, views: 10 }),
  ]);
  assertEquals(verdict.state, "ctr_winner");
});

Deno.test("a single label is not-enough-exposure, never a walkover", () => {
  const verdict = readVariantWinner([
    row({ activeLabel: "A", impressions: 100_000, views: 9_000 }),
  ]);
  assertEquals(verdict.state, "not_enough_exposure");
  assert(verdict.state === "not_enough_exposure");
  assertEquals(verdict.short, ["A"]);
});

Deno.test("no rows at all is not-enough-exposure with nothing to show", () => {
  const verdict = readVariantWinner([]);
  assertEquals(verdict.state, "not_enough_exposure");
  assert(verdict.state === "not_enough_exposure");
  assertEquals(verdict.variants, []);
});

// ── the lift threshold ─────────────────────────────────────────────────────

Deno.test("a difference below MIN_CTR_LIFT is not a winner", () => {
  // 0.055 vs 0.050 is a 1.1x lift: real-looking, under the bar.
  const verdict = readVariantWinner([
    row({ activeLabel: "A", impressions: 10_000, views: 550 }),
    row({ activeLabel: "B", impressions: 10_000, views: 500 }),
  ]);
  assertEquals(verdict.state, "no_clear_winner");
});

Deno.test("the lift is a RATIO, so the same point-gap decides differently by scale", () => {
  // Both pairs differ by 0.4 percentage points. Only the low-rate pair is a
  // real change in behaviour, and only it wins.
  const small = readVariantWinner([
    row({ activeLabel: "A", impressions: 100_000, views: 800 }), // 0.8%
    row({ activeLabel: "B", impressions: 100_000, views: 400 }), // 0.4%
  ]);
  assertEquals(small.state, "ctr_winner");

  const large = readVariantWinner([
    row({ activeLabel: "A", impressions: 100_000, views: 8_400 }), // 8.4%
    row({ activeLabel: "B", impressions: 100_000, views: 8_000 }), // 8.0%
  ]);
  assertEquals(large.state, "no_clear_winner");
});

Deno.test("everyone above the floor clicking nothing is no winner, not a tie-break", () => {
  const verdict = readVariantWinner([
    row({ activeLabel: "A", impressions: 10_000, views: 0 }),
    row({ activeLabel: "B", impressions: 10_000, views: 0 }),
  ]);
  assertEquals(verdict.state, "no_clear_winner");
});

Deno.test("a runner-up at zero clicks gives an infinite lift, not a crash", () => {
  const verdict = readVariantWinner([
    row({ activeLabel: "A", impressions: 10_000, views: 500 }),
    row({ activeLabel: "B", impressions: 10_000, views: 0 }),
  ]);
  assertEquals(verdict.state, "ctr_winner");
  assert(verdict.state === "ctr_winner");
  assertEquals(verdict.label, "A");
  assertEquals(verdict.ctrLift, Infinity);
});

// ── AC6: the clickbait case ────────────────────────────────────────────────

Deno.test("AC6: higher CTR with LOWER sell-through is reported, and flagged", () => {
  // B wins the click by a mile and sells nothing. This is the failure mode
  // CTR-only optimisation walks straight into, so it is named rather than
  // silently promoted.
  const verdict = readVariantWinner([
    // A: 1% CTR, sells half of what it lists.
    row({ activeLabel: "A", impressions: 10_000, views: 100, sold: true }),
    row({ activeLabel: "A", impressions: 10_000, views: 100, sold: false }),
    // B: 5% CTR, sells none of it.
    row({ activeLabel: "B", impressions: 10_000, views: 500, sold: false }),
    row({ activeLabel: "B", impressions: 10_000, views: 500, sold: false }),
  ]);

  assertEquals(verdict.state, "ctr_winner");
  assert(verdict.state === "ctr_winner");
  assertEquals(verdict.label, "B", "the CTR winner was not reported");
  assertEquals(
    verdict.agreesWithSellThrough,
    false,
    "a title that wins the click and loses the sale was reported as agreeing",
  );
  // The caller has everything it needs to refuse promotion.
  const a = verdict.variants.find((v) => v.label === "A")!;
  const b = verdict.variants.find((v) => v.label === "B")!;
  assertEquals(a.sellThrough, 0.5);
  assertEquals(b.sellThrough, 0);
});

Deno.test("AC2: when both readouts agree the winner says so", () => {
  const verdict = readVariantWinner([
    row({ activeLabel: "A", impressions: 10_000, views: 500, sold: true }),
    row({ activeLabel: "B", impressions: 10_000, views: 100, sold: false }),
  ]);
  assertEquals(verdict.state, "ctr_winner");
  assert(verdict.state === "ctr_winner");
  assertEquals(verdict.label, "A");
  assertEquals(verdict.agreesWithSellThrough, true);
});

Deno.test("a sell-through tie counts as agreement, because it argues nothing", () => {
  const verdict = readVariantWinner([
    row({ activeLabel: "A", impressions: 10_000, views: 500, sold: false }),
    row({ activeLabel: "B", impressions: 10_000, views: 100, sold: false }),
  ]);
  assert(verdict.state === "ctr_winner");
  assertEquals(verdict.agreesWithSellThrough, true);
});

// ── AC4: per prompt version ────────────────────────────────────────────────

Deno.test("AC4: CTR is also sliced by the prompt version that wrote the listing", () => {
  const out = summarizeCtrByPromptVersion([
    row({ promptVersion: "listing_gen_v1", impressions: 1_000, views: 10 }),
    row({ promptVersion: "listing_gen_v1", impressions: 1_000, views: 10 }),
    row({ promptVersion: "listing_gen_v2", impressions: 1_000, views: 40 }),
  ]);
  assertEquals(out.map((r) => r.promptVersion), ["listing_gen_v1", "listing_gen_v2"]);
  assertEquals(out[0]!.clickThroughRate, 20 / 2000);
  assertEquals(out[1]!.clickThroughRate, 40 / 1000);
});

Deno.test("an unattributed listing is DROPPED, not bucketed as unknown", () => {
  // An "unknown" bucket produces a number that sits beside the real ones and
  // looks comparable to them. It is not: it is every era mixed together.
  const out = summarizeCtrByPromptVersion([
    row({ promptVersion: null }),
    row({ promptVersion: "   " }),
    row({ promptVersion: "listing_gen_v1" }),
  ]);
  assertEquals(out.map((r) => r.promptVersion), ["listing_gen_v1"]);
  assertEquals(out[0]!.listings, 1);
});

Deno.test("the variant rollup lists which prompt versions produced each label", () => {
  const out = summarizeVariantCtr([
    row({ activeLabel: "A", promptVersion: "listing_gen_v2" }),
    row({ activeLabel: "A", promptVersion: "listing_gen_v1" }),
    row({ activeLabel: "A", promptVersion: "listing_gen_v1" }),
  ]);
  assertEquals(out[0]!.promptVersions, ["listing_gen_v1", "listing_gen_v2"]);
});

// ── the constants are usable numbers ───────────────────────────────────────

Deno.test("the thresholds are sane: a floor above zero and a lift above parity", () => {
  assert(MIN_VARIANT_IMPRESSIONS > 0);
  assert(MIN_CTR_LIFT > 1, "a lift threshold at or below 1 declares every difference a win");
});
