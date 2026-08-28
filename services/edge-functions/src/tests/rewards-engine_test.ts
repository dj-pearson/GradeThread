// US-1849: Rewards XP engine — pure catalog / level / state math. No DB.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  computeRewardState,
  isOffPlatformEmbedReferer,
  LEVEL_BASE,
  levelForXp,
  REWARD_XP_CATALOG,
  xpForEvent,
  xpForLevel,
} = await import("../lib/rewards-engine.ts");
type RewardEventInput = Parameters<typeof computeRewardState>[0][number];

const at = (day: number) => new Date(day * 86_400_000).toISOString();

// ── xpForEvent + the paid gate (AC4) ──────────────────────────────

Deno.test("catalog weights moat acts highest", () => {
  assert(REWARD_XP_CATALOG.badge_embedded > REWARD_XP_CATALOG.aspects_filled);
  assert(REWARD_XP_CATALOG.marketplace_connected > REWARD_XP_CATALOG.verified_share);
});

Deno.test("non-grading events always earn their catalog XP", () => {
  assertEquals(xpForEvent("badge_embedded"), 50);
  assertEquals(xpForEvent("marketplace_connected"), 40);
  assertEquals(xpForEvent("aspects_filled"), 10);
});

Deno.test("grading-spend events earn 0 unless paid (AC4)", () => {
  assertEquals(xpForEvent("grade_confirmed", { paid: false }), 0);
  assertEquals(xpForEvent("grade_confirmed", { paid: true }), 30);
  assertEquals(xpForEvent("coverage_completed"), 0); // default unpaid
  assertEquals(xpForEvent("coverage_completed", { paid: true }), 25);
  assertEquals(xpForEvent("verified_purchase", { paid: true }), 15);
});

Deno.test("unverified events earn 0 (anti-gaming)", () => {
  assertEquals(xpForEvent("badge_embedded", { verified: false }), 0);
});

// ── level curve ───────────────────────────────────────────────────

Deno.test("level curve is a legible quadratic", () => {
  assertEquals(levelForXp(0), 0);
  assertEquals(levelForXp(LEVEL_BASE - 1), 0);
  assertEquals(levelForXp(LEVEL_BASE), 1); // 100 → L1
  assertEquals(levelForXp(4 * LEVEL_BASE), 2); // 400 → L2
  assertEquals(levelForXp(9 * LEVEL_BASE), 3); // 900 → L3
  assertEquals(xpForLevel(3), 900);
  // monotonic non-decreasing
  let prev = -1;
  for (let xp = 0; xp <= 2500; xp += 50) {
    const l = levelForXp(xp);
    assert(l >= prev);
    prev = l;
  }
});

// ── computeRewardState ────────────────────────────────────────────

Deno.test("state sums XP, applies the paid gate, and levels up", () => {
  const events: RewardEventInput[] = [
    { eventType: "badge_embedded", occurredAt: at(1), verified: true }, // 50
    { eventType: "marketplace_connected", occurredAt: at(1), verified: true }, // 40
    { eventType: "grade_confirmed", occurredAt: at(2), verified: true, paid: true }, // 30
    { eventType: "grade_confirmed", occurredAt: at(2), verified: true, paid: false }, // 0 (unpaid)
    { eventType: "aspects_filled", occurredAt: at(3), verified: false }, // 0 (unverified)
  ];
  const s = computeRewardState(events);
  assertEquals(s.xpTotal, 120);
  assertEquals(s.level, levelForXp(120)); // 1
});

Deno.test("streaks count consecutive active days", () => {
  const events: RewardEventInput[] = [
    { eventType: "badge_embedded", occurredAt: at(10), verified: true },
    { eventType: "badge_embedded", occurredAt: at(11), verified: true },
    { eventType: "badge_embedded", occurredAt: at(12), verified: true }, // 3-day run
    { eventType: "badge_embedded", occurredAt: at(20), verified: true },
    { eventType: "badge_embedded", occurredAt: at(21), verified: true }, // current 2-day run ending latest
  ];
  const s = computeRewardState(events);
  assertEquals(s.longestStreak, 3);
  assertEquals(s.currentStreak, 2);
});

Deno.test("a 0-XP event does not create a streak day", () => {
  const events: RewardEventInput[] = [
    { eventType: "coverage_completed", occurredAt: at(5), verified: true, paid: false }, // 0 XP
  ];
  const s = computeRewardState(events);
  assertEquals(s.xpTotal, 0);
  assertEquals(s.currentStreak, 0);
  assertEquals(s.longestStreak, 0);
});

Deno.test("empty log is a zeroed state", () => {
  assertEquals(computeRewardState([]), {
    xpTotal: 0,
    // US-1851: the pure reducer reports the fresh total as the peak; the
    // monotonic floor against the STORED peak is applied in recomputeRewardState,
    // which is the only place that knows what was there before.
    xpPeak: 0,
    level: 0,
    currentStreak: 0,
    longestStreak: 0,
  });
});

// ── badge_embedded gate (AC3) ─────────────────────────────────────
// This predicate stands between the catalog's HIGHEST award and a public,
// unauthenticated image endpoint, so its failure mode has to be "earn nothing".

Deno.test("an off-platform referer is the badge_embedded signal", () => {
  assert(isOffPlatformEmbedReferer("https://www.ebay.com/itm/12345"));
  assert(isOffPlatformEmbedReferer("https://poshmark.com/listing/abc"));
  assert(isOffPlatformEmbedReferer("http://someones-blog.example/post"));
});

Deno.test("our own surfaces are not an embed", () => {
  assert(!isOffPlatformEmbedReferer("https://gradethread.com/cert/abc"));
  assert(!isOffPlatformEmbedReferer("https://www.gradethread.com/dashboard"));
  assert(!isOffPlatformEmbedReferer("https://functions.gradethread.com/api/x"));
  assert(!isOffPlatformEmbedReferer("http://localhost:5173/cert/abc"));
  // A lookalike host is NOT ours — endsWith on the dotted suffix, not a substring.
  assert(isOffPlatformEmbedReferer("https://notgradethread.com/x"));
  assert(isOffPlatformEmbedReferer("https://gradethread.com.evil.test/x"));
});

// ── AC3 source wiring ─────────────────────────────────────────────
// The catalog is only a policy until something calls grantReward. These scan the
// source because the alternative — a live OAuth callback per marketplace — is not
// testable here, and a provider silently missing its grant is exactly the drift
// the shared helper exists to prevent.

Deno.test("every marketplace provider grants marketplace_connected", async () => {
  for (const provider of ["ebay", "depop", "etsy", "shopify", "whatnot"]) {
    const src = await Deno.readTextFile(
      new URL(`../lib/${provider}-client.ts`, import.meta.url),
    );
    assert(
      src.includes("grantMarketplaceConnectedReward("),
      `${provider}-client.ts does not grant marketplace_connected`,
    );
    assert(
      src.includes(`"${provider}"`),
      `${provider}-client.ts does not name its own marketplace`,
    );
  }
});

Deno.test("the remaining catalog events are wired at a source", async () => {
  const wiring: Array<[string, string]> = [
    ["../lib/grading-pipeline.ts", "coverage_completed"],
    ["../lib/badge-analytics.ts", "verified_share"],
    ["../lib/buyer-grade-confirmation.ts", "grade_confirmed"],
    ["../routes/flipdesk-ai.ts", "aspects_filled"],
    ["../routes/content-public.ts", "badge_embedded"],
    ["../lib/share-to-earn.ts", "share_milestone"],
  ];
  for (const [path, eventType] of wiring) {
    const src = await Deno.readTextFile(new URL(path, import.meta.url));
    assert(
      src.includes(`grantReward(`) && src.includes(`"${eventType}"`),
      `${path} does not grant ${eventType}`,
    );
  }
});

Deno.test("no usable referer earns nothing (safe default)", () => {
  assert(!isOffPlatformEmbedReferer(null));
  assert(!isOffPlatformEmbedReferer(undefined));
  assert(!isOffPlatformEmbedReferer(""));
  assert(!isOffPlatformEmbedReferer("not a url"));
  assert(!isOffPlatformEmbedReferer("/cert/abc")); // relative — unparseable
});

// ── US-2969: the pipeline stages ──────────────────────────────────
// The catalog IS the reward policy, so the numbers are asserted rather than
// merely written down. A future edit that quietly repaces progression fails
// here instead of in a seller's dashboard six weeks later.

const PIPELINE_XP: Array<[string, number]> = [
  ["item_cataloged", 2],
  ["item_measured", 2],
  ["item_photographed", 3],
  ["item_comped", 3],
  ["item_drafted", 3],
  ["item_listed", 8],
  ["item_sold", 15],
];

Deno.test("pipeline stages carry their catalog values", () => {
  for (const [eventType, xp] of PIPELINE_XP) {
    assertEquals(
      (REWARD_XP_CATALOG as Record<string, number>)[eventType],
      xp,
      `${eventType} moved`,
    );
  }
});

Deno.test("pipeline stages are not paid-gated", () => {
  // Unlike coverage_completed / grade_confirmed / verified_purchase, a pipeline
  // stage consumes no AI spend, so it scores with no `paid` flag at all.
  for (const [eventType, xp] of PIPELINE_XP) {
    assertEquals(xpForEvent(eventType as never), xp);
    assertEquals(xpForEvent(eventType as never, { paid: false }), xp);
  }
});

Deno.test("pipeline stages are not variable-XP: a stray award is ignored", () => {
  // Only quest_completed / share_milestone read an award off the event. A
  // pipeline mark carrying one must still score the catalog value.
  assertEquals(xpForEvent("item_listed" as never, { xpAward: 200 }), 8);
});

Deno.test("an unverified pipeline mark earns nothing", () => {
  assertEquals(xpForEvent("item_sold" as never, { verified: false }), 0);
});

Deno.test("item economics: grading more than doubles a listed item", () => {
  const stages = (keys: string[]) =>
    keys.reduce((sum, k) => sum + xpForEvent(k as never), 0);

  const listedUngraded = stages([
    "item_cataloged",
    "item_measured",
    "item_photographed",
    "item_comped",
    "item_drafted",
    "item_listed",
  ]);
  assertEquals(listedUngraded, 21);

  const listedGraded = listedUngraded +
    xpForEvent("coverage_completed", { paid: true });
  assertEquals(listedGraded, 46);
  assert(listedGraded > listedUngraded * 2, "grading must beat doubling busywork");

  assertEquals(listedGraded + xpForEvent("item_sold" as never), 61);
});

Deno.test("pacing: ten items a week reaches Picker in the advertised time", () => {
  // Picker is level 3 (rewards-levels.ts), which is 900 XP on the existing curve.
  const perWeekUngraded = 21 * 10;
  const perWeekGraded = 46 * 10;
  const weeksTo = (perWeek: number) => {
    for (let w = 1; w <= 52; w++) if (levelForXp(perWeek * w) >= 3) return w;
    return Infinity;
  };
  assertEquals(levelForXp(perWeekUngraded), 1, "level 1 in the first week");
  assertEquals(weeksTo(perWeekUngraded), 5, "Picker in about five weeks ungraded");
  assertEquals(weeksTo(perWeekGraded), 2, "Picker in about two weeks graded");
});
