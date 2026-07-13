// US-1850: achievements — pure catalog + criteria evaluation. No DB.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { BADGE_CATALOG, badgeByKey, evaluateBadges } = await import(
  "../lib/rewards-badges.ts"
);
type BadgeContext = Parameters<typeof evaluateBadges>[0];

const ctx = (over: Partial<BadgeContext> = {}): BadgeContext => ({
  gradeCount: 0,
  perfect10Count: 0,
  nwtCount: 0,
  longestStreak: 0,
  shareCount: 0,
  marketplaceCount: 0,
  xpTotal: 0,
  level: 0,
  ...over,
});

Deno.test("catalog keys are unique and every tier is valid", () => {
  const keys = BADGE_CATALOG.map((b) => b.key);
  assertEquals(new Set(keys).size, keys.length, "duplicate badge keys");
  for (const b of BADGE_CATALOG) {
    assert(["bronze", "silver", "gold"].includes(b.tier), `${b.key} bad tier`);
    assert(b.name.length > 0 && b.icon.length > 0);
  }
});

Deno.test("an empty context earns nothing", () => {
  assertEquals(evaluateBadges(ctx()), []);
});

Deno.test("grade-count ladder unlocks by threshold", () => {
  assert(evaluateBadges(ctx({ gradeCount: 1 })).includes("first_grade"));
  assert(!evaluateBadges(ctx({ gradeCount: 1 })).includes("grades_10"));
  assert(evaluateBadges(ctx({ gradeCount: 10 })).includes("grades_10"));
  const big = evaluateBadges(ctx({ gradeCount: 1000 }));
  // all lower tiers also hold at 1000
  for (const k of ["first_grade", "grades_10", "grades_100", "grades_1000"]) {
    assert(big.includes(k), `expected ${k} at 1000 grades`);
  }
});

Deno.test("milestone badges unlock on their stat", () => {
  assert(evaluateBadges(ctx({ perfect10Count: 1 })).includes("perfect_10"));
  assert(evaluateBadges(ctx({ nwtCount: 1 })).includes("nwt_find"));
  assert(evaluateBadges(ctx({ longestStreak: 7 })).includes("streak_7"));
  assert(!evaluateBadges(ctx({ longestStreak: 6 })).includes("streak_7"));
  assert(evaluateBadges(ctx({ marketplaceCount: 1 })).includes("connected"));
  assert(evaluateBadges(ctx({ shareCount: 1 })).includes("first_share"));
  assert(evaluateBadges(ctx({ shareCount: 10 })).includes("viral_find"));
  assert(!evaluateBadges(ctx({ shareCount: 9 })).includes("viral_find"));
  assert(evaluateBadges(ctx({ level: 5 })).includes("level_5"));
});

Deno.test("badgeByKey resolves catalog entries", () => {
  assertEquals(badgeByKey("perfect_10")?.name, "Perfect 10");
  assertEquals(badgeByKey("viral_find")?.hidden, true);
  assertEquals(badgeByKey("nope"), undefined);
});
