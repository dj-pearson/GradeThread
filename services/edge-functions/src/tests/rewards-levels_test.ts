// US-1851: named levels, the monotonic floor, and the cosmetic perk gate.
//
// Every export under test is pure, so no env dance is needed — but the module
// imports rewards-engine.ts for the XP curve, and that pulls in lib/supabase.ts
// (`supabaseAdmin`), which throws at import when SUPABASE_URL is unset. Hence
// the env-then-dynamic-import shape (see ops-jobs_test.ts): a static top-of-file
// import would run BEFORE these lines.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

import { assert, assertEquals } from "@std/assert";

const {
  COSMETIC_PERKS,
  LEVEL_TIERS,
  isFrameUnlocked,
  levelProgress,
  lockedPerks,
  nextTierAfter,
  publicLevelFlair,
  tierForLevel,
  unlockedPerks,
} = await import("../lib/rewards-levels.ts");
const { peakXp, xpForLevel } = await import("../lib/rewards-engine.ts");

// ── Named tiers ──────────────────────────────────────────────────────────────

Deno.test("tierForLevel walks the ladder and never returns undefined", () => {
  assertEquals(tierForLevel(0).key, "thrifter");
  assertEquals(tierForLevel(2).key, "thrifter");
  assertEquals(tierForLevel(3).key, "picker");
  assertEquals(tierForLevel(6).key, "picker");
  assertEquals(tierForLevel(7).key, "curator");
  assertEquals(tierForLevel(11).key, "curator");
  assertEquals(tierForLevel(12).key, "archivist");
  assertEquals(tierForLevel(19).key, "archivist");
  assertEquals(tierForLevel(20).key, "legend");
  assertEquals(tierForLevel(999).key, "legend");
});

Deno.test("the tier ladder is strictly ascending — no two tiers share a floor", () => {
  for (let i = 1; i < LEVEL_TIERS.length; i++) {
    assert(
      LEVEL_TIERS[i].minLevel > LEVEL_TIERS[i - 1].minLevel,
      `${LEVEL_TIERS[i].key} must sit above ${LEVEL_TIERS[i - 1].key}`,
    );
  }
});

Deno.test("nextTierAfter returns the tier above, and null at the top", () => {
  assertEquals(nextTierAfter(0)?.key, "picker");
  assertEquals(nextTierAfter(6)?.key, "curator");
  assertEquals(nextTierAfter(20), null);
});

// ── Monotonic floor (AC1: a level NEVER decreases) ───────────────────────────

Deno.test("peakXp only ever moves up", () => {
  assertEquals(peakXp(0, 500), 500);
  assertEquals(peakXp(500, 900), 900);
  // The log shrank — an erasure, a fraud reversal, a cascade. The peak holds.
  assertEquals(peakXp(900, 100), 900);
  assertEquals(peakXp(null, 250), 250);
  assertEquals(peakXp(undefined, 0), 0);
  // Garbage in the column never drags the peak below the fresh total.
  assertEquals(peakXp(Number.NaN, 400), 400);
  assertEquals(peakXp(-50, 400), 400);
});

Deno.test("a shrinking XP total cannot demote the tier", () => {
  // 4,900 XP = level 7 = Curator.
  const earned = levelProgress(peakXp(0, 4900), 4900);
  assertEquals(earned.tier.key, "curator");
  // The live total collapses to 100 XP. Level is read off the peak, so the
  // seller is STILL a Curator — status earned is status kept.
  const after = levelProgress(peakXp(4900, 100), 100);
  assertEquals(after.level, earned.level);
  assertEquals(after.tier.key, "curator");
  assertEquals(after.xpTotal, 100); // the live total is reported honestly…
  assertEquals(after.xpPeak, 4900); // …but the identity rides the peak
});

// ── Progress ─────────────────────────────────────────────────────────────────

Deno.test("levelProgress reports the band the seller is inside", () => {
  // Level 3 floor is 900 XP; level 4 floor is 1600. 1250 sits mid-band.
  const p = levelProgress(1250);
  assertEquals(p.level, 3);
  assertEquals(p.tier.key, "picker");
  assertEquals(p.xpIntoLevel, 1250 - xpForLevel(3));
  assertEquals(p.xpLevelSpan, xpForLevel(4) - xpForLevel(3));
  assertEquals(p.xpToNextLevel, xpForLevel(4) - 1250);
  assertEquals(p.percentToNextLevel, 50);
  assertEquals(p.nextTier?.key, "curator");
  assertEquals(p.xpToNextTier, xpForLevel(7) - 1250);
});

Deno.test("a brand-new account is level 0 Thrifter, not an error", () => {
  const p = levelProgress(0);
  assertEquals(p.level, 0);
  assertEquals(p.tier.key, "thrifter");
  assertEquals(p.percentToNextLevel, 0);
  assertEquals(p.xpToNextLevel, xpForLevel(1));
});

Deno.test("at the top of the ladder there is no next tier to chase", () => {
  const p = levelProgress(xpForLevel(22));
  assertEquals(p.tier.key, "legend");
  assertEquals(p.nextTier, null);
  assertEquals(p.xpToNextTier, null);
});

// ── Cosmetic perks (AC4) ─────────────────────────────────────────────────────

Deno.test("perks unlock by level and partition cleanly", () => {
  for (const level of [0, 3, 7, 12, 20, 40]) {
    const unlocked = unlockedPerks(level);
    const locked = lockedPerks(level);
    assertEquals(
      unlocked.length + locked.length,
      COSMETIC_PERKS.length,
      "every perk is either unlocked or locked, never both or neither",
    );
    for (const p of unlocked) assert(level >= p.minLevel);
    for (const p of locked) assert(level < p.minLevel);
  }
  assertEquals(unlockedPerks(0).map((p) => p.key), ["flair_thrifter"]);
  assertEquals(unlockedPerks(20).length, COSMETIC_PERKS.length);
});

Deno.test("every perk is cosmetic — nothing here has a price or a capability", () => {
  for (const perk of COSMETIC_PERKS) {
    assert(
      perk.kind === "flair" || perk.kind === "frame",
      `${perk.key} is neither flair nor a frame — AC4 forbids a perk that gates a capability`,
    );
    // A perk's tier must actually exist on the ladder, or it can never unlock.
    assert(
      LEVEL_TIERS.some((t) => t.key === perk.tier && t.minLevel === perk.minLevel),
      `${perk.key} names a tier/level pair that isn't on the ladder`,
    );
  }
});

Deno.test("the frame gate fails CLOSED", () => {
  assertEquals(isFrameUnlocked("frame_legend", 20), true);
  assertEquals(isFrameUnlocked("frame_legend", 19), false);
  assertEquals(isFrameUnlocked("frame_curator", 7), true);
  // Unknown key, empty, null, and a non-frame perk all resolve to "no frame".
  assertEquals(isFrameUnlocked("frame_does_not_exist", 999), false);
  assertEquals(isFrameUnlocked("", 999), false);
  assertEquals(isFrameUnlocked(null, 999), false);
  assertEquals(isFrameUnlocked("flair_thrifter", 999), false);
});

// ── Public projection ────────────────────────────────────────────────────────

Deno.test("publicLevelFlair carries the rank and never the XP", () => {
  const flair = publicLevelFlair(9) as unknown as Record<string, unknown>;
  assertEquals(flair.tier_key, "curator");
  assertEquals(flair.tier_name, "Curator");
  assertEquals(flair.level, 9);
  // XP is a business metric (how much they grade, how often they list) and is
  // NOT public. Assert the absence, not just the presence of the rank.
  assertEquals(Object.hasOwn(flair, "xp_total"), false);
  assertEquals(Object.hasOwn(flair, "xp_peak"), false);
  assertEquals(Object.hasOwn(flair, "xpTotal"), false);
});
