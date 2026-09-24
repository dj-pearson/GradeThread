// The seller's leaderboard panel: what it shows while loading, after a failed
// read, across a period switch, and what a save sends and says.
//
// Real react-query and the real hooks; only the network (edgeFetch) and the
// toast are stubbed, so keepPreviousData and the mutation's intent-based toast
// are what is actually under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

import { edgeFetch } from "@/lib/edge-fetch";
import { leaderboardSaveToast, type MyLeaderboardState } from "@/hooks/use-leaderboards";
import { LeaderboardPanel } from "@/components/rewards/leaderboard-panel";

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockedFetch = vi.mocked(edgeFetch);

function state(over: Partial<MyLeaderboardState> = {}): MyLeaderboardState {
  return {
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
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route GETs to `get(period)` and PUTs to `put(body)`. */
function server(opts: {
  get: (period: string) => Response | Promise<Response>;
  put?: (body: Record<string, unknown>) => Response;
}) {
  const puts: Array<Record<string, unknown>> = [];
  mockedFetch.mockImplementation(async (path: string, init?: { method?: string; json?: unknown }) => {
    if (init?.method === "PUT") {
      const body = (init.json ?? {}) as Record<string, unknown>;
      puts.push(body);
      return opts.put ? opts.put(body) : json({ opt_in: true, alias: null, resolved_alias: null });
    }
    const period = new URL(path, "https://x.test").searchParams.get("period") ?? "all_time";
    return opts.get(period);
  });
  return puts;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      h(QueryClientProvider, { client }, h(MemoryRouter, null, h(LeaderboardPanel))),
    );
  });
  await flush();
}

function input(): HTMLInputElement {
  return container!.querySelector("#leaderboard-alias") as HTMLInputElement;
}

function type(value: string) {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container!.querySelectorAll("button")].find((b) =>
    b.textContent?.trim() === label
  ) as HTMLButtonElement | undefined;
}

async function click(label: string) {
  const b = button(label);
  expect(b, `no "${label}" button`).toBeDefined();
  act(() => b!.click());
  await flush();
}

beforeEach(() => {
  mockedFetch.mockReset();
  vi.mocked(toast.success).mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("LeaderboardPanel (R9)", () => {
  it("shows a skeleton, not the opted-out copy, on first load", async () => {
    server({ get: () => new Promise<Response>(() => {}) });
    await render();
    expect(container!.querySelector('[role="status"]')).not.toBeNull();
    expect(container!.textContent).not.toContain("not on the boards");
  });

  it("switching period keeps the typed alias, the joined copy and the buttons", async () => {
    let resolveWeekly: (r: Response) => void = () => {};
    server({
      get: (period) =>
        period === "weekly"
          ? new Promise<Response>((r) => (resolveWeekly = r))
          : json(state()),
    });
    await render();
    type("New Name");
    await click("This week");

    // Mid-fetch: previous data is held, nothing blanks.
    expect(input().value).toBe("New Name");
    expect(container!.textContent).toContain("You're on the boards.");
    expect(button("This week")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("All time")?.getAttribute("aria-pressed")).toBe("false");

    // The weekly read lands with a different stored alias; the typed one wins.
    resolveWeekly(json(state({ period: "weekly", alias: "Server Name" })));
    await flush();
    expect(input().value).toBe("New Name");
  });

  it("a failed read still offers Retry and Hide me", async () => {
    const puts = server({ get: () => json({ error: "nope" }, 500) });
    await render();
    expect(container!.textContent).toContain("Couldn't load your standing.");
    expect(button("Retry")).toBeDefined();
    await click("Hide me from the boards");
    expect(puts).toEqual([{ enabled: false }]);
  });

  it("joining with an untouched field sends no alias", async () => {
    const puts = server({
      get: () => json(state({ opt_in: false, alias: null, resolved_alias: "Verified Name" })),
      put: () => json({ opt_in: true, alias: null, resolved_alias: "Verified Name" }),
    });
    await render();
    expect(input().value).toBe("");
    expect(input().placeholder).toBe("Verified Name");
    await click("Join the boards");
    expect(puts).toEqual([{ enabled: true }]);
    expect(toast.success).toHaveBeenCalledWith("You're on the leaderboards.");
  });

  it("Save is disabled until the name changes, and a rename says Name updated", async () => {
    const puts = server({
      get: () => json(state()),
      put: () => json({ opt_in: true, alias: "Goblin King", resolved_alias: "Goblin King" }),
    });
    await render();
    expect(button("Save name")?.disabled).toBe(true);
    type("Goblin King");
    expect(button("Save name")?.disabled).toBe(false);
    await click("Save name");
    expect(puts).toEqual([{ alias: "Goblin King" }]);
    const said = vi.mocked(toast.success).mock.calls[0]?.[0] as string;
    expect(said).toMatch(/^Name updated/);
  });

  it("a tied rank is read out as tied", async () => {
    server({ get: () => json(state()) });
    await render();
    const spoken = [...container!.querySelectorAll('[data-testid="rank-spoken"]')].map(
      (n) => n.textContent,
    );
    expect(spoken).toContain("Rank 3, tied");
  });

  it("R4: shows the server's sentence for a refused name under the field", async () => {
    server({
      get: () => json(state()),
      put: () => json({ error: "That display name is reserved. Pick another one." }, 400),
    });
    await render();
    type("GradeThread Support");
    await click("Save name");
    const alert = container!.querySelector("#leaderboard-alias-error");
    expect(alert?.textContent).toBe("That display name is reserved. Pick another one.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("leaderboardSaveToast", () => {
  it("speaks to the intent, not the resulting state", () => {
    const on = { optIn: true, resolvedAlias: "Goblin" };
    expect(leaderboardSaveToast({ enabled: true }, on)).toBe("You're on the leaderboards.");
    expect(leaderboardSaveToast({ enabled: false }, { optIn: false, resolvedAlias: null })).toBe(
      "Removed from the leaderboards.",
    );
    expect(leaderboardSaveToast({ alias: "Goblin" }, on)).toBe(
      "Name updated. You'll show as Goblin.",
    );
  });
});
