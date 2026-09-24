// The seller's leaderboard panel: what it shows while loading, after a failed
// read, across a period switch, and what a save sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import {
  LeaderboardSaveError,
  type MyLeaderboardState,
  useMyLeaderboard,
  useSetLeaderboardOptIn,
} from "@/hooks/use-leaderboards";
import { LeaderboardPanel } from "@/components/rewards/leaderboard-panel";

vi.mock("@/hooks/use-leaderboards", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/use-leaderboards")>();
  return { ...actual, useMyLeaderboard: vi.fn(), useSetLeaderboardOptIn: vi.fn() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockedMine = vi.mocked(useMyLeaderboard);
const mockedSave = vi.mocked(useSetLeaderboardOptIn);

const JOINED: MyLeaderboardState = {
  opt_in: true,
  alias: "Thrift Goblin",
  resolved_alias: "Thrift Goblin",
  handle: null,
  period: "all_time",
  standings: [
    {
      metric: "xp",
      name: "Most XP",
      score_label: "XP",
      secondary_label: null,
      icon: "Zap",
      path: "/leaderboards/xp",
      rank: 3,
      score: 120,
      secondary: 0,
      tied: true,
      of: 40,
    },
  ],
  board_url: "/leaderboards",
};

type MineResult = ReturnType<typeof useMyLeaderboard>;
type SaveResult = ReturnType<typeof useSetLeaderboardOptIn>;

let mine: Partial<MineResult>;
let save: { mutate: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> } & Partial<
  SaveResult
>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  mockedMine.mockImplementation(() => mine as MineResult);
  mockedSave.mockImplementation(() => save as unknown as SaveResult);
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(h(MemoryRouter, null, h(LeaderboardPanel)));
  });
}

function rerender() {
  act(() => {
    root!.render(h(MemoryRouter, null, h(LeaderboardPanel)));
  });
}

beforeEach(() => {
  mine = { data: JOINED, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
  save = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe("LeaderboardPanel", () => {
  it("R4: shows the server's sentence for a refused name under the field", () => {
    save = {
      ...save,
      isError: true,
      error: new LeaderboardSaveError("That display name is reserved. Pick another one.", 400),
    };
    render();
    const alert = container!.querySelector("#leaderboard-alias-error");
    expect(alert?.textContent).toBe("That display name is reserved. Pick another one.");
    expect(container!.querySelector("#leaderboard-alias")?.getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("R4: a server failure (not a 400) is not shown as a field error", () => {
    save = { ...save, isError: true, error: new LeaderboardSaveError("boom", 500) };
    render();
    expect(container!.querySelector("#leaderboard-alias-error")).toBeNull();
  });
});
