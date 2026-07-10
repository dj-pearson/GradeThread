import { describe, expect, it } from "vitest";
import {
  nextReputationLevel,
  perkHighlights,
  REPUTATION_LEVELS,
  REPUTATION_PERKS,
  reputationLevelMeta,
  resolveReputationPerks,
} from "@/lib/reputation-perks";

// US-1817: web mirror of the edge perk matrix. These pinned values MUST stay in
// lockstep with services/edge-functions/src/lib/buyer-reputation-perks.ts
// (buyer-reputation-perks_test.ts pins the identical values on the edge side).

describe("REPUTATION_LEVELS / PERKS matrix (lockstep with edge)", () => {
  it("pins thresholds and slugs", () => {
    expect(REPUTATION_LEVELS.map((l) => l.minScore)).toEqual([0, 40, 120, 300]);
    expect(REPUTATION_LEVELS.map((l) => l.slug)).toEqual(["new", "trusted", "established", "connoisseur"]);
  });

  it("pins the perk matrix values", () => {
    expect(REPUTATION_PERKS[0]).toEqual({ guaranteeWindowBonusDays: 0, priorityClaimHandling: false, earlyDropAccess: false, rewardMultiplier: 1.0 });
    expect(REPUTATION_PERKS[3]).toEqual({ guaranteeWindowBonusDays: 30, priorityClaimHandling: true, earlyDropAccess: true, rewardMultiplier: 1.25 });
  });

  it("is monotonic — climbing never costs a perk", () => {
    for (let i = 1; i < REPUTATION_PERKS.length; i++) {
      expect(REPUTATION_PERKS[i]!.guaranteeWindowBonusDays).toBeGreaterThanOrEqual(REPUTATION_PERKS[i - 1]!.guaranteeWindowBonusDays);
      expect(REPUTATION_PERKS[i]!.rewardMultiplier).toBeGreaterThanOrEqual(REPUTATION_PERKS[i - 1]!.rewardMultiplier);
    }
  });
});

describe("resolveReputationPerks", () => {
  it("is fail-safe clamped for out-of-range levels", () => {
    expect(resolveReputationPerks(-1)).toEqual(resolveReputationPerks(0));
    expect(resolveReputationPerks(99)).toEqual(resolveReputationPerks(3));
    expect(resolveReputationPerks(Number.NaN)).toEqual(resolveReputationPerks(0));
  });

  it("lapses perks on downgrade", () => {
    expect(resolveReputationPerks(2).priorityClaimHandling).toBe(true);
    expect(resolveReputationPerks(1).priorityClaimHandling).toBe(false);
  });
});

describe("nextReputationLevel", () => {
  it("reports points-away and null at the top", () => {
    expect(nextReputationLevel(10, 0)).toEqual({ level: REPUTATION_LEVELS[1], pointsAway: 30 });
    expect(nextReputationLevel(500, 3)).toBeNull();
    expect(nextReputationLevel(45, 0)?.pointsAway).toBe(0);
  });
});

describe("perkHighlights", () => {
  it("lists only unlocked perks, newest tier richer", () => {
    expect(perkHighlights(0)).toEqual([]);
    const top = perkHighlights(3);
    expect(top).toContain("+30 days guarantee coverage");
    expect(top).toContain("25% bonus rewards");
    expect(top).toContain("Early access to graded drops");
  });
});

describe("reputationLevelMeta", () => {
  it("names and clamps", () => {
    expect(reputationLevelMeta(2).name).toBe("Established");
    expect(reputationLevelMeta(42).slug).toBe("connoisseur");
  });
});
