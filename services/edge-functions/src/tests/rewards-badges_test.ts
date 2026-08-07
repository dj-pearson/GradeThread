// US-1850: achievements — pure catalog + criteria evaluation. No DB.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { BADGE_CATALOG, badgeByKey, countViralFinds, evaluateBadges, publicAchievements } =
  await import("../lib/rewards-badges.ts");
type BadgeContext = Parameters<typeof evaluateBadges>[0];

const ctx = (over: Partial<BadgeContext> = {}): BadgeContext => ({
  gradeCount: 0,
  perfect10Count: 0,
  nwtCount: 0,
  longestStreak: 0,
  shareCount: 0,
  viralFindCount: 0,
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
  // US-1854: Viral Find is ONE find that travelled, not many finds clicked once.
  assert(evaluateBadges(ctx({ viralFindCount: 1 })).includes("viral_find"));
  assert(!evaluateBadges(ctx({ shareCount: 50 })).includes("viral_find"));
  assert(evaluateBadges(ctx({ level: 5 })).includes("level_5"));
});

Deno.test("badgeByKey resolves catalog entries", () => {
  assertEquals(badgeByKey("perfect_10")?.name, "Perfect 10");
  assertEquals(badgeByKey("viral_find")?.hidden, true);
  assertEquals(badgeByKey("nope"), undefined);
});

// ─── publicAchievements — the projection the verified profile renders ────────

Deno.test("US-1850 AC3: earned rows project to catalog metadata, rarest first", () => {
  const out = publicAchievements([
    { badge_key: "first_grade", earned_at: "2026-01-01T00:00:00Z" },
    { badge_key: "grades_1000", earned_at: "2026-03-01T00:00:00Z" },
    { badge_key: "perfect_10", earned_at: "2026-02-01T00:00:00Z" },
    { badge_key: "streak_7", earned_at: "2026-05-01T00:00:00Z" },
  ]);
  // gold, then the two silvers newest-first, then bronze.
  assertEquals(out.map((a) => a.key), [
    "grades_1000",
    "streak_7",
    "perfect_10",
    "first_grade",
  ]);
  assertEquals(out[0]?.name, "Master Grader");
  assertEquals(out[0]?.tier, "gold");
  assertEquals(out[0]?.icon, "Trophy");
  assertEquals(out[0]?.earned_at, "2026-03-01T00:00:00Z");
});

Deno.test("US-1850 AC3: the projection never leaks the private context snapshot", () => {
  const row = {
    badge_key: "perfect_10",
    earned_at: "2026-02-01T00:00:00Z",
    // A real user_badges row also carries `context` (the owner's stats) and
    // user_id. Neither may reach a public profile.
    context: { perfect10Count: 3 },
    user_id: "11111111-1111-1111-1111-111111111111",
  };
  const [dto] = publicAchievements([row]);
  assertEquals(Object.keys(dto ?? {}).sort(), [
    "description",
    "earned_at",
    "icon",
    "key",
    "name",
    "tier",
  ]);
});

Deno.test("US-1850 AC3: a retired key drops out, a hidden badge shows once earned", () => {
  const out = publicAchievements([
    { badge_key: "retired_badge_from_an_old_catalog", earned_at: "2026-01-01T00:00:00Z" },
    { badge_key: "viral_find", earned_at: "2026-01-02T00:00:00Z" },
  ]);
  assertEquals(out.map((a) => a.key), ["viral_find"]);
});

Deno.test("US-1850 AC3: no earned rows means no medals", () => {
  assertEquals(publicAchievements([]), []);
});

// ─── US-1854: viral finds are counted per FIND, not per event ────────────────

Deno.test("countViralFinds counts distinct finds at a viral rung", () => {
  // Two rungs on ONE find is one viral find.
  assertEquals(
    countViralFinds(["share:cert:ABC:viral", "share:cert:ABC:signup"]),
    1,
  );
  // Two different finds is two.
  assertEquals(
    countViralFinds(["share:cert:ABC:viral", "share:cert:XYZ:signup"]),
    2,
  );
});

Deno.test("countViralFinds ignores lower rungs and foreign keys", () => {
  assertEquals(
    countViralFinds([
      "share:cert:ABC:spark",
      "share:cert:ABC:buzz",
      "quest:weekly_share:w2026-08-03",
      "cert:ABC:share",
      "",
    ]),
    0,
  );
});
