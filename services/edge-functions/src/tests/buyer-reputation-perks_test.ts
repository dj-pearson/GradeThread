// US-1817: buyer reputation levels/badges/perks — the perk matrix, monotonicity,
// downgrade safety, level metadata, and the composition helpers.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  REPUTATION_LEVELS,
  REPUTATION_PERKS,
  resolveReputationPerks,
  reputationLevelMeta,
  nextReputationLevel,
  effectiveGuaranteeWindowDays,
  applyRewardMultiplier,
} = await import("../lib/buyer-reputation-perks.ts");

Deno.test("levels derive from the scoring engine thresholds (0/40/120/300)", () => {
  assertEquals(REPUTATION_LEVELS.map((l) => l.minScore), [0, 40, 120, 300]);
  assertEquals(REPUTATION_LEVELS.map((l) => l.slug), ["new", "trusted", "established", "connoisseur"]);
  assertEquals(REPUTATION_LEVELS[3].name, "Connoisseur");
});

Deno.test("perk matrix is monotonic — climbing never costs a perk", () => {
  for (let i = 1; i < REPUTATION_PERKS.length; i++) {
    const lo = REPUTATION_PERKS[i - 1];
    const hi = REPUTATION_PERKS[i];
    assert(hi.guaranteeWindowBonusDays >= lo.guaranteeWindowBonusDays);
    assert(hi.rewardMultiplier >= lo.rewardMultiplier);
    assert(Number(hi.priorityClaimHandling) >= Number(lo.priorityClaimHandling));
    assert(Number(hi.earlyDropAccess) >= Number(lo.earlyDropAccess));
  }
});

Deno.test("new buyers get no bonuses; connoisseurs get the full set", () => {
  assertEquals(resolveReputationPerks(0), {
    guaranteeWindowBonusDays: 0,
    priorityClaimHandling: false,
    earlyDropAccess: false,
    rewardMultiplier: 1.0,
  });
  const top = resolveReputationPerks(3);
  assert(top.earlyDropAccess);
  assert(top.priorityClaimHandling);
  assertEquals(top.guaranteeWindowBonusDays, 30);
});

Deno.test("downgrade lapses perks cleanly (perks are a pure fn of current level)", () => {
  // Established → decayed back to Trusted: priority claims + early access lapse.
  assert(resolveReputationPerks(2).priorityClaimHandling);
  assert(!resolveReputationPerks(1).priorityClaimHandling);
  assertEquals(resolveReputationPerks(1).rewardMultiplier, 1.0);
});

Deno.test("clamp is fail-safe for out-of-range / garbage levels", () => {
  assertEquals(resolveReputationPerks(-5), resolveReputationPerks(0));
  assertEquals(resolveReputationPerks(99), resolveReputationPerks(3));
  assertEquals(resolveReputationPerks(NaN), resolveReputationPerks(0));
});

Deno.test("nextReputationLevel reports points-away and null at the top", () => {
  const fromNew = nextReputationLevel(10, 0);
  assertEquals(fromNew?.level.slug, "trusted");
  assertEquals(fromNew?.pointsAway, 30); // 40 - 10
  const atTop = nextReputationLevel(500, 3);
  assertEquals(atTop, null);
  // Already past the next threshold in points but not yet leveled → 0 away.
  assertEquals(nextReputationLevel(45, 0)?.pointsAway, 0);
});

Deno.test("reputationLevelMeta is clamped and named", () => {
  assertEquals(reputationLevelMeta(2).name, "Established");
  assertEquals(reputationLevelMeta(42).slug, "connoisseur");
});

Deno.test("composition helpers apply the reputation bonus additively", () => {
  // Guarantee window: base 60 + connoisseur bonus 30 = 90.
  assertEquals(effectiveGuaranteeWindowDays(60, 3), 90);
  assertEquals(effectiveGuaranteeWindowDays(60, 0), 60); // new = no bonus
  // Reward multiplier: base 100 * established 1.1 = 110 (raw product; the
  // consumer rounds — JS float makes this 110.000…1).
  assertAlmostEquals(applyRewardMultiplier(100, 2), 110, 1e-9);
  assertEquals(applyRewardMultiplier(100, 0), 100);
});
