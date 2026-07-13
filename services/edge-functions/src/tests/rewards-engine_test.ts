// US-1849: Rewards XP engine — pure catalog / level / state math. No DB.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  computeRewardState,
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
    level: 0,
    currentStreak: 0,
    longestStreak: 0,
  });
});
