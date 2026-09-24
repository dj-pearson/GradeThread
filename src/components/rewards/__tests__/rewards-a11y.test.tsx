// R14: every rewards progress bar has a name and a value, and a failed
// integrity read does not pose as "Building history".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";

import { useRewards } from "@/hooks/use-rewards";
import { useQuests } from "@/hooks/use-quests";
import { RewardsPage } from "@/pages/rewards";
import { rewardsFixture } from "@/test/rewards-fixture";

vi.mock("@/hooks/use-rewards", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/use-rewards")>();
  return { ...actual, useRewards: vi.fn() };
});
vi.mock("@/hooks/use-quests", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/use-quests")>();
  return { ...actual, useQuests: vi.fn() };
});
vi.mock("@/hooks/use-nudge-attribution", () => ({ useNudgeAttribution: vi.fn() }));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));
vi.mock("@/components/rewards/reward-celebrations", () => ({ RewardCelebrations: () => null }));
vi.mock("@/components/rewards/leaderboard-panel", () => ({ LeaderboardPanel: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUEST = {
  id: "q1",
  key: "week_grade_3",
  name: "Grade three items",
  description: "",
  quest_type: "personal" as const,
  metric: "coverage_completed",
  target: 3,
  cadence: "weekly" as const,
  xp_reward: 30,
  icon: "Camera",
  period_key: "w2026-09-21",
  window_ends_at: "2099-01-01T00:00:00.000Z",
  progress: { current: 1, target: 3, complete: false, percent: 33 },
  completed_at: null,
  xp_awarded: 0,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(url: string, over: Parameters<typeof rewardsFixture>[0] = {}) {
  vi.mocked(useRewards).mockReturnValue({
    rewards: rewardsFixture(over),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useRewards>);
  const router = createMemoryRouter([{ path: "/dashboard/rewards", element: h(RewardsPage) }], {
    initialEntries: [url],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(h(RouterProvider, { router }));
  });
}

beforeEach(() => {
  vi.mocked(useQuests).mockReturnValue({
    quests: {
      enabled: true,
      quests: [QUEST],
      challenges: [{
        ...QUEST,
        key: "c1",
        quest_type: "community" as const,
        standings: [],
        your_rank: null,
        you_are_listed: false,
      }],
      season_timezone: "UTC",
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useQuests>);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function bars(): HTMLElement[] {
  return [...container!.querySelectorAll('[role="progressbar"]')] as HTMLElement[];
}

describe("rewards progress bars (R14)", () => {
  const loyalty = {
    member_since: "2025-01-01T00:00:00Z",
    months: 20,
    years: 1,
    paid_months: 10,
    tier: { key: "regular", label: "Regular", blurb: "", rank: 1, credit_multiplier: 1 },
    next_tier: { key: "veteran", label: "Veteran", blurb: "", rank: 2, credit_multiplier: 1.1 },
    months_to_next: 4,
    paid_months_to_next: 2,
    credit_multiplier: 1,
    last_anniversary_year: 1,
  };
  const milestones = {
    enabled: true,
    granted: [],
    next: {
      key: "m1",
      label: "A free grade",
      reward_type: "free_grade_credits",
      value: 1,
      xp_threshold: 500,
      xp_from: 0,
      xp_remaining: 80,
      percent: 84,
    },
  };

  for (const tab of ["standing", "season"]) {
    it(`every bar on the ${tab} tab is named and valued`, () => {
      mount(`/dashboard/rewards?tab=${tab}`, { loyalty, milestones });
      const found = bars();
      expect(found.length).toBeGreaterThan(tab === "season" ? 3 : 1);
      for (const bar of found) {
        expect(bar.getAttribute("aria-label"), bar.outerHTML).toBeTruthy();
        expect(bar.getAttribute("aria-valuenow"), bar.outerHTML).toMatch(/^\d+$/);
      }
    });
  }

  it("the level figure is the peak the level is computed from", () => {
    mount("/dashboard/rewards");
    expect(container!.textContent).toContain("450 XP earned");
    expect(container!.textContent).not.toContain("Level up ready");
  });
});

describe("integrity read failure (R14)", () => {
  it("renders the neutral line, not Building history", () => {
    mount("/dashboard/rewards", {
      integrity: { ...rewardsFixture().integrity, unavailable: true },
    });
    expect(container!.textContent).toContain(
      "Couldn't load your integrity standing right now. Nothing has changed.",
    );
    expect(container!.textContent).not.toContain("Building history");
  });
});
