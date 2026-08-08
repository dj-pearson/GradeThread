import { describe, expect, it } from "vitest";
import {
  applyCelebrationLimits,
  CELEBRATION_POLICY,
  celebrationStateKey,
  detectCelebrations,
  EMPTY_CELEBRATION_LOG,
  readCelebrationState,
  writeCelebrationState,
  type CelebrationContext,
  type CelebrationEvent,
  type CelebrationLog,
  type CelebrationStore,
  type RewardSnapshot,
} from "@/lib/reward-celebrations";

// US-1857: the celebration policy is the whole reason this feature can ship to
// a professional audience, so it is tested as policy — what gets a party, what
// gets a quiet line, and what a FlipDesk user bulk-processing hundreds of items
// is protected from.

const CTX: CelebrationContext = {
  tierName: "Curator",
  badgeName: (key) => `Badge ${key}`,
  badgeTier: (key) => (key === "viral_find" ? "gold" : "bronze"),
  milestoneLabel: (key) => `Reward ${key}`,
  tenureName: "Two years in",
};

function snap(over: Partial<RewardSnapshot> = {}): RewardSnapshot {
  return {
    level: 4,
    xpTotal: 1_600,
    badges: ["first_grade"],
    seasonKey: "2026-Q3",
    seasonGoalsCompleted: 1,
    seasonGoalsTotal: 4,
    integrityTier: null,
    milestones: [],
    tenureRank: 0,
    anniversaryYear: 0,
    ...over,
  };
}

function log(over: Partial<CelebrationLog> = {}): CelebrationLog {
  return { ...EMPTY_CELEBRATION_LOG, ...over };
}

describe("detectCelebrations", () => {
  it("fires NOTHING on the first read (a baseline is not an achievement)", () => {
    // The sharpest failure this guards: without it, every existing user gets a
    // level-up party for a level they reached months ago, the first time they
    // open the dashboard after this ships.
    expect(detectCelebrations(null, snap({ level: 12, xpTotal: 20_000 }), CTX)).toEqual([]);
  });

  it("celebrates a level up and offers the level card to share", () => {
    const events = detectCelebrations(snap(), snap({ level: 5, xpTotal: 2_500 }), CTX);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("level_up");
    expect(events[0]!.tier).toBe("celebrate");
    expect(events[0]!.share).toEqual(
      expect.objectContaining({ kind: "level", key: "5" }),
    );
  });

  it("suppresses the routine XP toast when something bigger happened", () => {
    const events = detectCelebrations(snap(), snap({ level: 5, xpTotal: 2_500 }), CTX);
    expect(events.some((e) => e.kind === "xp_gain")).toBe(false);
  });

  it("gives routine XP one quiet, AGGREGATED toast — never one per event", () => {
    // 900 XP is many rewardable actions. It is still one line.
    const events = detectCelebrations(snap(), snap({ xpTotal: 2_500 }), CTX);
    expect(events).toHaveLength(1);
    expect(events[0]!.tier).toBe("quiet");
    expect(events[0]!.title).toBe("+900 XP");
  });

  it("celebrates a FIRST badge but only quietly announces the ones after it", () => {
    const first = detectCelebrations(
      snap({ badges: [] }),
      snap({ badges: ["first_grade"] }),
      CTX,
    );
    expect(first[0]!.tier).toBe("celebrate");

    const second = detectCelebrations(
      snap({ badges: ["first_grade"] }),
      snap({ badges: ["first_grade", "grades_10"] }),
      CTX,
    );
    expect(second[0]!.tier).toBe("quiet");
    // Still shareable — the tier decides the fanfare, not whether it's an event.
    expect(second[0]!.share).toEqual(expect.objectContaining({ kind: "badge" }));
  });

  it("celebrates a gold badge even when it is not the first", () => {
    const events = detectCelebrations(
      snap({ badges: ["first_grade"] }),
      snap({ badges: ["first_grade", "viral_find"] }),
      CTX,
    );
    expect(events[0]!.tier).toBe("celebrate");
  });

  it("celebrates a season sweep, and only on the transition", () => {
    const swept = detectCelebrations(
      snap({ seasonGoalsCompleted: 3 }),
      snap({ seasonGoalsCompleted: 4 }),
      CTX,
    );
    expect(swept.map((e) => e.kind)).toContain("season_complete");

    const alreadySwept = detectCelebrations(
      snap({ seasonGoalsCompleted: 4 }),
      snap({ seasonGoalsCompleted: 4 }),
      CTX,
    );
    expect(alreadySwept).toEqual([]);
  });

  it("does not read a QUARTER ROLLOVER as a sweep", () => {
    // A new season starts at 0/4. Comparing across season keys would otherwise
    // let a reset look like a completion (or a completion look like a loss).
    const events = detectCelebrations(
      snap({ seasonKey: "2026-Q3", seasonGoalsCompleted: 4 }),
      snap({ seasonKey: "2026-Q4", seasonGoalsCompleted: 4 }),
      CTX,
    );
    expect(events.map((e) => e.kind)).not.toContain("season_complete");
  });

  it("stays silent on the integrity tier when there is none to show", () => {
    const events = detectCelebrations(snap(), snap({ integrityTier: null }), CTX);
    expect(events.map((e) => e.kind)).not.toContain("integrity_tier");

    const wired = detectCelebrations(snap(), snap({ integrityTier: "reliable" }), CTX);
    expect(wired.map((e) => e.kind)).toContain("integrity_tier");
  });

  // US-1912: a demotion changes the tier string exactly like a promotion does,
  // so equality alone would throw confetti at someone who just lost standing.
  // The seller hears about a drop privately, from the edge, with its driver —
  // this surface must stay silent.
  it("never celebrates an integrity tier going DOWN", () => {
    const down = detectCelebrations(
      snap({ integrityTier: "trusted" }),
      snap({ integrityTier: "verified" }),
      CTX,
    );
    expect(down.map((e) => e.kind)).not.toContain("integrity_tier");

    const up = detectCelebrations(
      snap({ integrityTier: "verified" }),
      snap({ integrityTier: "trusted" }),
      CTX,
    );
    expect(up.map((e) => e.kind)).toContain("integrity_tier");
  });

  // Falling below the display floor is a demotion to "building history", which
  // is not a moment either.
  it("never celebrates dropping to the pre-floor building state", () => {
    const events = detectCelebrations(
      snap({ integrityTier: "elite" }),
      snap({ integrityTier: "building" }),
      CTX,
    );
    expect(events.map((e) => e.kind)).not.toContain("integrity_tier");
  });

  it("celebrates a tangible grant (each one is granted exactly once, ever)", () => {
    const events = detectCelebrations(
      snap(),
      snap({ milestones: ["xp_2500_credits_3"] }),
      CTX,
    );
    expect(events[0]!.kind).toBe("milestone_granted");
    expect(events[0]!.tier).toBe("celebrate");
    expect(events[0]!.message).toContain("Reward xp_2500_credits_3");
  });

  it("orders celebrations before quiet lines", () => {
    const events = detectCelebrations(
      snap({ badges: ["first_grade"] }),
      snap({ level: 5, badges: ["first_grade", "grades_10"] }),
      CTX,
    );
    expect(events.map((e) => e.tier)).toEqual(["celebrate", "quiet"]);
  });
});

describe("applyCelebrationLimits", () => {
  const celebration = (id: string): CelebrationEvent => ({
    id,
    kind: "level_up",
    tier: "celebrate",
    title: id,
    message: "",
    share: null,
  });
  const quiet = (id: string): CelebrationEvent => ({
    id,
    kind: "xp_gain",
    tier: "quiet",
    title: id,
    message: "",
    share: null,
  });

  it("spaces celebrations out — a burst of five shows one", () => {
    const events = [1, 2, 3, 4, 5].map((n) => celebration(`c${n}`));
    const { show } = applyCelebrationLimits(events, log(), 1_000_000);
    expect(show).toHaveLength(1);
  });

  it("caps celebrations per rolling hour", () => {
    const now = 10_000_000;
    const recent = [now - 30 * 60_000, now - 20 * 60_000, now - 10 * 60_000];
    const { show } = applyCelebrationLimits(
      [celebration("c1")],
      log({ celebrations: recent }),
      now,
    );
    expect(show).toHaveLength(0);
    expect(CELEBRATION_POLICY.maxPerWindow).toBe(recent.length);
  });

  it("lets a celebration through once the window has rolled past", () => {
    const now = 10_000_000;
    const stale = [now - 90 * 60_000, now - 80 * 60_000, now - 70 * 60_000];
    const { show, log: next } = applyCelebrationLimits(
      [celebration("c1")],
      log({ celebrations: stale }),
      now,
    );
    expect(show).toHaveLength(1);
    expect(next.celebrations).toEqual([now]);
  });

  it("never repeats an event it has already handled", () => {
    const first = applyCelebrationLimits([celebration("c1")], log(), 1_000);
    expect(first.show).toHaveLength(1);
    const again = applyCelebrationLimits([celebration("c1")], first.log, 10_000_000);
    expect(again.show).toHaveLength(0);
  });

  it("marks a SUPPRESSED event seen rather than replaying it later", () => {
    // A celebration that arrives twenty minutes after the thing it celebrates is
    // worse than one that never fired — and nothing is lost, because the level,
    // badge and grant all sit on the rewards page permanently.
    const { log: after } = applyCelebrationLimits(
      [celebration("c1"), celebration("c2")],
      log(),
      1_000,
    );
    const later = applyCelebrationLimits([celebration("c2")], after, 10_000_000);
    expect(later.show).toHaveLength(0);
  });

  it("throttles routine XP toasts to one per cooldown", () => {
    const now = 5_000_000;
    const fresh = applyCelebrationLimits([quiet("x1")], log(), now);
    expect(fresh.show).toHaveLength(1);

    const spam = applyCelebrationLimits([quiet("x2")], fresh.log, now + 30_000);
    expect(spam.show).toHaveLength(0);

    const later = applyCelebrationLimits(
      [quiet("x3")],
      fresh.log,
      now + CELEBRATION_POLICY.quietGapMs + 1,
    );
    expect(later.show).toHaveLength(1);
  });

  it("shows at most one quiet toast per pass", () => {
    const { show } = applyCelebrationLimits([quiet("x1"), quiet("x2")], log(), 5_000_000);
    expect(show).toHaveLength(1);
  });

  it("keeps the seen list bounded", () => {
    let state = log();
    for (let i = 0; i < CELEBRATION_POLICY.seenLimit + 50; i++) {
      state = applyCelebrationLimits([quiet(`x${i}`)], state, i * 10).log;
    }
    expect(state.seen).toHaveLength(CELEBRATION_POLICY.seenLimit);
  });
});

describe("persistence", () => {
  function memory(): CelebrationStore & { data: Record<string, string> } {
    const data: Record<string, string> = {};
    return {
      data,
      get: (k) => data[k] ?? null,
      set: (k, v) => {
        data[k] = v;
      },
    };
  }

  it("round-trips per user", () => {
    const store = memory();
    writeCelebrationState("user-a", { snapshot: snap(), log: log({ lastQuietAt: 42 }) }, store);
    const back = readCelebrationState("user-a", store);
    expect(back.snapshot?.level).toBe(4);
    expect(back.log.lastQuietAt).toBe(42);
    // A different account on the same browser must not inherit it.
    expect(readCelebrationState("user-b", store).snapshot).toBeNull();
    expect(store.data[celebrationStateKey("user-a")]).toBeTruthy();
  });

  it("re-baselines on corrupt state instead of throwing", () => {
    const store = memory();
    store.set(celebrationStateKey("user-a"), "{not json");
    const back = readCelebrationState("user-a", store);
    expect(back.snapshot).toBeNull();
    expect(back.log).toEqual(EMPTY_CELEBRATION_LOG);
  });
});
