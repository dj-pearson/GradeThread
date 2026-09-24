// US-1852: the quests panel — what a seller sees for quests and community
// challenges, and the two things that must never leak out of it.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import {
  lastPeriodLine,
  newlyCompletedQuests,
  useQuests,
  type QuestsState,
} from "@/hooks/use-quests";
import { QuestsPanel, questTimeLeft } from "@/components/rewards/quests-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/use-quests", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/use-quests")>();
  return { ...actual, useQuests: vi.fn() };
});

const mocked = vi.mocked(useQuests);

const QUEST = {
  id: "q1",
  key: "week_grade_3",
  name: "Grade three items",
  description: "Grade 3 items with full photo coverage this week.",
  quest_type: "personal" as const,
  metric: "coverage_completed",
  target: 3,
  cadence: "weekly" as const,
  xp_reward: 30,
  icon: "Camera",
  period_key: "w2026-08-03",
  window_ends_at: "2099-01-01T00:00:00.000Z",
  progress: { current: 1, target: 3, complete: false, percent: 33 },
  completed_at: null,
  xp_awarded: 0,
};

const CHALLENGE = {
  ...QUEST,
  id: "c1",
  key: "aug_best_find",
  name: "Best thrift find of the month",
  quest_type: "community" as const,
  cadence: "fixed" as const,
  period_key: "fixed",
  standings: [
    { rank: 1, handle: "alpha", display_name: "Alpha", score: 9, is_you: false },
    { rank: 2, handle: "beta", display_name: "Beta", score: 4, is_you: true },
  ],
  your_rank: 2,
  you_are_listed: true,
};

function state(over: Partial<QuestsState> = {}): QuestsState {
  return {
    enabled: true,
    quests: [QUEST],
    challenges: [],
    season_timezone: "America/Chicago",
    ...over,
  };
}

function mount(s: QuestsState): string {
  mocked.mockReturnValue({
    quests: s,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useQuests>);
  return renderToStaticMarkup(
    <MemoryRouter>
      <QuestsPanel />
    </MemoryRouter>,
  );
}

describe("QuestsPanel (US-1852)", () => {
  beforeEach(() => mocked.mockReset());

  it("renders a personal quest with its progress and reward", () => {
    const html = mount(state());
    expect(html).toContain("Grade three items");
    expect(html).toContain("1/3");
    expect(html).toContain("+30 XP");
  });

  it("keeps a finished quest on the list instead of hiding it", () => {
    // A list that empties itself as you succeed reads as though nothing
    // happened — the point of the card is what the week looked like.
    const done = { ...QUEST, completed_at: "2026-08-06T00:00:00.000Z", xp_awarded: 30 };
    const html = mount(state({ quests: [done] }));
    expect(html).toContain("Grade three items");
    expect(html).toContain("1 of 1 done");
  });

  it("renders nothing at all when the program is switched off", () => {
    // The global kill-switch has to be visibly total: no heading, no empty card.
    expect(mount(state({ enabled: false }))).toBe("");
    expect(mount(state({ quests: [], challenges: [] }))).toBe("");
  });

  it("shows a community challenge board with the viewer's rank", () => {
    const html = mount(state({ quests: [], challenges: [CHALLENGE] }));
    expect(html).toContain("Best thrift find of the month");
    expect(html).toContain("Alpha");
    expect(html).toContain("ranked #2");
  });

  it("explains the board rather than silently omitting an unlisted seller", () => {
    const html = mount(
      state({
        quests: [],
        challenges: [{ ...CHALLENGE, your_rank: null, you_are_listed: false }],
      }),
    );
    // R3: the board takes the leaderboard opt-in, so the way onto it is the
    // Perks tab's boards panel, not the Verified profile.
    expect(html).toContain("Join the boards to be named here.");
    expect(html).toContain('href="/dashboard/rewards?tab=perks#leaderboard"');
    expect(html).not.toContain("ranked #");
  });
});

describe("last period line (R7)", () => {
  it("summarizes the window that just closed", () => {
    expect(lastPeriodLine({ label: "week", done: 3, total: 4, xp: 60 })).toBe(
      "Last week: 3 of 4 done, +60 XP.",
    );
    expect(lastPeriodLine({ label: "round", done: 0, total: 2, xp: 0 })).toBe(
      "Last round: 0 of 2 done.",
    );
  });

  it("renders under the quests heading when the server sends it", () => {
    const html = mount(state({ last_period: { label: "week", done: 1, total: 1, xp: 30 } }));
    expect(html).toContain("Last week: 1 of 1 done, +30 XP.");
  });
});

describe("questTimeLeft", () => {
  const now = Date.parse("2026-08-07T12:00:00Z");

  it("counts down in hours inside the last day and days above it", () => {
    expect(questTimeLeft("2026-08-07T18:00:00Z", now)).toBe("6 hours left");
    expect(questTimeLeft("2026-08-10T12:00:00Z", now)).toBe("3 days left");
  });

  it("says ended rather than showing a negative countdown", () => {
    expect(questTimeLeft("2026-08-01T12:00:00Z", now)).toBe("ended");
  });

  it("degrades to empty on an unparseable date", () => {
    expect(questTimeLeft("not-a-date", now)).toBe("");
  });
});

describe("QuestsPanel loading and error (R11)", () => {
  beforeEach(() => mocked.mockReset());

  it("shows a skeleton while loading instead of nothing", () => {
    mocked.mockReturnValue({
      quests: { enabled: false, quests: [], challenges: [], season_timezone: "UTC" },
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useQuests>);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QuestsPanel />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-label="Loading your quests"');
  });

  it("a failed read renders a retry button that refetches", () => {
    const refetch = vi.fn();
    mocked.mockReturnValue({
      quests: { enabled: false, quests: [], challenges: [], season_timezone: "UTC" },
      isLoading: false,
      isError: true,
      refetch,
    } as unknown as ReturnType<typeof useQuests>);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <QuestsPanel />
        </MemoryRouter>,
      );
    });
    expect(container.textContent).toContain("Couldn't load this week's quests.");
    const btn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent === "Try again"
    );
    act(() => btn!.click());
    expect(refetch).toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it("says scores reset when a challenge ends", () => {
    const html = mount(state({ quests: [], challenges: [CHALLENGE] }));
    expect(html).toContain("Scores reset when it ends.");
    expect(html).not.toContain("Ends and stays ended");
  });
});

describe("newlyCompletedQuests (R11)", () => {
  const since = Date.parse("2026-09-24T12:00:00Z");
  const done = (at: string) => ({ ...QUEST, completed_at: at, xp_awarded: 30 });

  it("finds a quest that finished between two reads", () => {
    const before = state({ quests: [QUEST] });
    const after = state({ quests: [done("2026-09-01T00:00:00Z")] });
    expect(newlyCompletedQuests(before, after, since)).toEqual(["week_grade_3:w2026-08-03"]);
    expect(newlyCompletedQuests(after, after, since)).toEqual([]);
  });

  it("on a first read, counts only a completion this read just paid", () => {
    expect(newlyCompletedQuests(null, state({ quests: [done("2026-09-24T12:00:30Z")] }), since))
      .toHaveLength(1);
    expect(newlyCompletedQuests(null, state({ quests: [done("2026-09-01T00:00:00Z")] }), since))
      .toEqual([]);
  });
});
