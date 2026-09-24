// R6: the Rewards tab lives in ?tab=, so a notification opens the tab that
// holds what it is about, and switching tabs does not grow the history stack.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";

import { useRewards } from "@/hooks/use-rewards";
import { RewardsPage } from "@/pages/rewards";
import { rewardsFixture } from "@/test/rewards-fixture";

vi.mock("@/hooks/use-rewards", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/use-rewards")>();
  return { ...actual, useRewards: vi.fn() };
});
vi.mock("@/hooks/use-nudge-attribution", () => ({ useNudgeAttribution: vi.fn() }));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));
vi.mock("@/components/rewards/reward-celebrations", () => ({ RewardCelebrations: () => null }));
vi.mock("@/components/rewards/quests-panel", () => ({
  QuestsPanel: () => h("div", { "data-testid": "quests-panel" }, "QUESTS"),
}));
vi.mock("@/components/rewards/leaderboard-panel", () => ({
  LeaderboardPanel: () => h("div", { "data-testid": "leaderboard-panel" }, "BOARDS"),
}));
vi.mock("@/components/rewards/milestone-rewards", () => ({ MilestoneRewards: () => null }));
vi.mock("@/components/rewards/badge-shelf", () => ({
  BadgeShelf: () => h("div", { "data-testid": "badge-shelf" }, "BADGES"),
}));
vi.mock("@/components/rewards/integrity-standing", () => ({ IntegrityStandingCard: () => null }));
vi.mock("@/components/rewards/loyalty-standing", () => ({ LoyaltyStandingCard: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocked = vi.mocked(useRewards);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(url: string) {
  const router = createMemoryRouter([{ path: "/dashboard/rewards", element: h(RewardsPage) }], {
    initialEntries: [url],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(h(RouterProvider, { router }));
  });
  return router;
}

beforeEach(() => {
  mocked.mockReturnValue({
    rewards: rewardsFixture(),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useRewards>);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function has(id: string): boolean {
  return !!container!.querySelector(`[data-testid="${id}"]`);
}

describe("Rewards tabs follow ?tab= (R6)", () => {
  it("opens on standing with no tab in the URL", () => {
    mount("/dashboard/rewards");
    expect(has("badge-shelf")).toBe(true);
    expect(has("quests-panel")).toBe(false);
  });

  it("?tab=season renders the quests panel", () => {
    mount("/dashboard/rewards?tab=season#quests");
    expect(has("quests-panel")).toBe(true);
    expect(container!.querySelector("#quests")).not.toBeNull();
  });

  it("a malformed #anchor is ignored instead of crashing the page", () => {
    const router = mount("/dashboard/rewards?tab=season#%E0%A4%A");
    expect(router.state.location.hash).toBe("#%E0%A4%A");
    expect(has("quests-panel")).toBe(true);
  });

  it("an unknown ?tab= falls back to standing rather than an empty page", () => {
    mount("/dashboard/rewards?tab=bogus");
    expect(has("badge-shelf")).toBe(true);
  });

  it("switching tabs writes ?tab= with REPLACE and keeps ?nudge=", () => {
    const router = mount("/dashboard/rewards?nudge=abc");
    const trigger = [...container!.querySelectorAll('[role="tab"]')].find((el) =>
      el.textContent?.includes("Perks")
    ) as HTMLElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get("tab")).toBe("perks");
    expect(params.get("nudge")).toBe("abc");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(has("leaderboard-panel")).toBe(true);
  });
});

describe("Rewards loading state (R8)", () => {
  it("renders the header and a labelled skeleton, not a bare spinner", () => {
    mocked.mockReturnValue({
      rewards: null,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useRewards>);
    mount("/dashboard/rewards");
    expect(container!.textContent).toContain("Rewards");
    const status = container!.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("Loading your rewards");
    expect(container!.querySelector(".animate-spin")).toBeNull();
  });
});

describe("season goals link to the work (R15)", () => {
  it("an incomplete goal shows a working link and the pace line", () => {
    mount("/dashboard/rewards?tab=season");
    const link = [...container!.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Grade an item")
    );
    expect(link?.getAttribute("href")).toBe("/dashboard/submissions/new");
    expect(container!.textContent).toContain("On pace for 0 of 1 goal.");
  });
});
