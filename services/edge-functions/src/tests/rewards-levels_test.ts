// US-1851 AC1 + AC4: the named level ladder and its cosmetic-only perks.
//
// Two of these tests are PINS rather than ordinary unit tests — they read the
// source of other files and fail on a change of policy, not a change of value.
// They are here because both rules are promises to sellers that a future edit
// could break silently: a level that can go down, and a perk behind a paywall.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  FRAME_STYLES,
  frameStyleForLevel,
  isFrameUnlocked,
  LEVEL_TIERS,
  levelProgress,
  monotonicLevel,
  nextTierAfter,
  perksForLevel,
  tierForLevel,
} = await import("../lib/rewards-levels.ts");
const { levelForXp, xpForLevel } = await import("../lib/rewards-engine.ts");

// ── The ladder itself ────────────────────────────────────────────────────────

Deno.test("tiers are ordered ascending and start at level 0", () => {
  assertEquals(LEVEL_TIERS[0]?.minLevel, 0);
  for (let i = 1; i < LEVEL_TIERS.length; i++) {
    assert(
      LEVEL_TIERS[i]!.minLevel > LEVEL_TIERS[i - 1]!.minLevel,
      `tier ${LEVEL_TIERS[i]!.key} must sit above ${LEVEL_TIERS[i - 1]!.key}`,
    );
  }
});

Deno.test("tier keys and flair are unique — no two rungs say the same thing", () => {
  assertEquals(new Set(LEVEL_TIERS.map((t) => t.key)).size, LEVEL_TIERS.length);
  assertEquals(new Set(LEVEL_TIERS.map((t) => t.flair)).size, LEVEL_TIERS.length);
});

Deno.test("every non-null frame has a paint style and appears once", () => {
  const frames = LEVEL_TIERS.map((t) => t.frame).filter((f) => f !== null);
  assertEquals(new Set(frames).size, frames.length);
  for (const f of frames) assert(FRAME_STYLES[f!], `no style for frame ${f}`);
});

Deno.test("tierForLevel walks the bands and never returns null", () => {
  assertEquals(tierForLevel(0).key, "thrifter");
  assertEquals(tierForLevel(2).key, "thrifter");
  assertEquals(tierForLevel(3).key, "picker"); // exact boundary belongs to the new tier
  assertEquals(tierForLevel(5).key, "picker");
  assertEquals(tierForLevel(6).key, "curator");
  assertEquals(tierForLevel(10).key, "archivist");
  assertEquals(tierForLevel(16).key, "legend");
  assertEquals(tierForLevel(999).key, "legend");
});

Deno.test("tierForLevel is defensive about junk levels", () => {
  assertEquals(tierForLevel(-5).key, "thrifter");
  assertEquals(tierForLevel(Number.NaN).key, "thrifter");
  assertEquals(tierForLevel(3.9).key, "picker"); // floored, not rounded up
});

Deno.test("nextTierAfter points up the ladder and runs out at the top", () => {
  assertEquals(nextTierAfter(0)?.key, "picker");
  assertEquals(nextTierAfter(3)?.key, "curator");
  assertEquals(nextTierAfter(15)?.key, "legend");
  assertEquals(nextTierAfter(16), null);
});

// ── Rule 1: a level NEVER decreases ──────────────────────────────────────────

Deno.test("monotonicLevel floors a recompute at the stored level", () => {
  assertEquals(monotonicLevel(7, 4), 7); // a void/re-weight pulled XP down
  assertEquals(monotonicLevel(4, 7), 7); // ordinary growth still promotes
  assertEquals(monotonicLevel(null, 3), 3);
  assertEquals(monotonicLevel(undefined, 0), 0);
  assertEquals(monotonicLevel(-2, -9), 0); // never negative
  assertEquals(monotonicLevel(Number.NaN, 5), 5);
});

Deno.test("levelProgress honours the stored floor and clamps the bar", () => {
  // A seller banked level 6 (3,600 XP) and then lost XP back to 2,000.
  const p = levelProgress(2000, 6);
  assertEquals(p.level, 6);
  assertEquals(p.tier.key, "curator");
  assertEquals(p.xpIntoLevel, 0); // clamped, never negative
  assertEquals(p.pctToNextLevel, 0);
  assert(p.xpToNextLevel > 0);
});

Deno.test("rewards-engine applies the floor where the cache is written", async () => {
  // PIN: recomputeRewardState must not write a raw computed level over a
  // higher stored one, or rule 1 is only true in this file.
  const src = await Deno.readTextFile(
    new URL("../lib/rewards-engine.ts", import.meta.url),
  );
  const recompute = src.slice(src.indexOf("export async function recomputeRewardState"));
  assert(
    recompute.includes("monotonicLevel("),
    "recomputeRewardState must floor the new level with monotonicLevel",
  );
});

// ── Progress math ────────────────────────────────────────────────────────────

Deno.test("levelProgress derives the level from XP when none is stored", () => {
  const p = levelProgress(900);
  assertEquals(p.level, 3);
  assertEquals(p.xpTotal, 900);
  assertEquals(p.xpIntoLevel, 0);
  assertEquals(p.xpForNextLevel, xpForLevel(4) - xpForLevel(3)); // 1600 - 900
  assertEquals(p.xpToNextLevel, 700);
  assertEquals(p.pctToNextLevel, 0);
});

Deno.test("levelProgress reports halfway through a band", () => {
  const p = levelProgress(900 + 350); // half of the 700-wide level-3 band
  assertEquals(p.level, 3);
  assertEquals(p.pctToNextLevel, 50);
});

Deno.test("levelProgress reports the gap to the next TIER, not just the next level", () => {
  const p = levelProgress(1000); // level 3 (Picker); Curator starts at level 6
  assertEquals(p.tier.key, "picker");
  assertEquals(p.nextTier?.key, "curator");
  assertEquals(p.xpToNextTier, xpForLevel(6) - 1000); // 3600 - 1000
});

Deno.test("levelProgress has no next tier at the top of the ladder", () => {
  const p = levelProgress(xpForLevel(16));
  assertEquals(p.tier.key, "legend");
  assertEquals(p.nextTier, null);
  assertEquals(p.xpToNextTier, null);
});

Deno.test("levelProgress survives junk XP", () => {
  for (const xp of [-100, Number.NaN, Number.POSITIVE_INFINITY]) {
    const p = levelProgress(xp);
    assert(p.level >= 0);
    assert(p.pctToNextLevel >= 0 && p.pctToNextLevel <= 100);
  }
});

Deno.test("the tier boundaries line up with the XP curve they claim", () => {
  for (const t of LEVEL_TIERS) {
    // One XP short of the band's floor must still be the tier below.
    if (t.minLevel === 0) continue;
    const floor = xpForLevel(t.minLevel);
    assertEquals(levelForXp(floor), t.minLevel);
    assert(tierForLevel(levelForXp(floor)).key === t.key);
    assert(tierForLevel(levelForXp(floor - 1)).key !== t.key);
  }
});

// ── Rule 2: perks are cosmetic and never plan-gated ──────────────────────────

Deno.test("perks accumulate — an earned frame stays earned", () => {
  assertEquals(perksForLevel(0).frames, []);
  assertEquals(perksForLevel(0).activeFrame, null);
  assertEquals(perksForLevel(3).frames, ["copper"]);
  assertEquals(perksForLevel(6).frames, ["copper", "slate"]);
  assertEquals(perksForLevel(10).frames, ["copper", "slate", "gold"]);
  assertEquals(perksForLevel(16).frames, ["copper", "slate", "gold", "crimson"]);
  assertEquals(perksForLevel(16).activeFrame, "crimson");
});

Deno.test("perks flair matches the tier's flair", () => {
  for (const t of LEVEL_TIERS) {
    assertEquals(perksForLevel(t.minLevel).flair, t.flair);
  }
});

Deno.test("isFrameUnlocked gates a render path", () => {
  assert(!isFrameUnlocked("gold", 6));
  assert(isFrameUnlocked("gold", 10));
  assert(isFrameUnlocked("copper", 10)); // lower frames stay selectable
  assert(!isFrameUnlocked("not-a-frame", 99));
});

Deno.test("frameStyleForLevel carries the tier's own name as the label", () => {
  assertEquals(frameStyleForLevel(0), null);
  const gold = frameStyleForLevel(12);
  assertEquals(gold?.key, "gold");
  assertEquals(gold?.label, "Archivist");
  assertEquals(gold?.edge, FRAME_STYLES.gold.edge);
});

Deno.test("PIN: no perk in the ladder is plan- or entitlement-gated", async () => {
  // Levels are earned by contributing. The moment a plan, tier price, or
  // entitlement check appears in this module the ladder becomes a price list,
  // so the mention itself is the failure — not any particular behaviour.
  const src = await Deno.readTextFile(
    new URL("../lib/rewards-levels.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
  for (const banned of ["entitlement", "subscription", "stripe", "plan_", "requiresPlan", "isPro"]) {
    assert(
      !code.toLowerCase().includes(banned.toLowerCase()),
      `rewards-levels.ts must not reference "${banned}" — perks are level-gated only`,
    );
  }
});

// ── AC2/AC3 boundary: sellers see seasons, not streaks ───────────────────────

Deno.test("PIN: no seller surface renders currentStreak", async () => {
  // computeRewardState still measures a daily streak for the streak_7 badge,
  // but US-1851 decided it is internal measurement, not seller identity. If a
  // seller-facing route or page starts reading it, that decision has quietly
  // reversed.
  const roots = [
    new URL("../routes/", import.meta.url),
    new URL("../lib/", import.meta.url),
  ];
  const allowed = new Set(["rewards-engine.ts", "rewards-badges.ts"]);
  const offenders: string[] = [];
  for (const root of roots) {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      if (allowed.has(entry.name)) continue;
      const src = await Deno.readTextFile(new URL(entry.name, root));
      if (/currentStreak/.test(src)) offenders.push(entry.name);
    }
  }
  assertEquals(
    offenders,
    [],
    `these files expose currentStreak; sellers see season progress instead: ${offenders.join(", ")}`,
  );
});
