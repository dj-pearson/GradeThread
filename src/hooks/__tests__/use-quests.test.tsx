// R11: GET /quests pays a finished quest on read, so the level card's read goes
// stale the moment one completes. The hook refreshes it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { edgeFetch } from "@/lib/edge-fetch";
import { useQuests, type QuestsState } from "@/hooks/use-quests";

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

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
  progress: { current: 2, target: 3, complete: false, percent: 66 },
  completed_at: null as string | null,
  xp_awarded: 0,
};

function body(completed: boolean): QuestsState {
  return {
    enabled: true,
    quests: [completed ? { ...QUEST, completed_at: new Date().toISOString(), xp_awarded: 30 } : QUEST],
    challenges: [],
    season_timezone: "UTC",
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let refetch: (() => Promise<unknown>) | null = null;

function Probe() {
  const q = useQuests();
  refetch = q.refetch;
  return null;
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("useQuests (R11)", () => {
  it("invalidates rewards-state when a quest newly completes", async () => {
    let completed = false;
    vi.mocked(edgeFetch).mockImplementation(async () =>
      new Response(JSON.stringify(body(completed)), { status: 200 })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries");
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container!);
      root.render(h(QueryClientProvider, { client }, h(Probe)));
    });
    await flush();
    expect(spy).not.toHaveBeenCalled();

    completed = true;
    await act(async () => {
      await refetch!();
    });
    await flush();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["rewards-state"] });
  });

  it("does not read quests at all while disabled", async () => {
    vi.mocked(edgeFetch).mockClear();
    const client = new QueryClient();
    function Off() {
      useQuests({ enabled: false });
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container!);
      root.render(h(QueryClientProvider, { client }, h(Off)));
    });
    await flush();
    expect(edgeFetch).not.toHaveBeenCalled();
  });
});
