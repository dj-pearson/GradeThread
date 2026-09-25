// The leaderboard list: seeded rows render at once, a save refreshes the
// cached board, ranks come from the server and ties say so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://functions.example.test" }));

import { TopReferrers } from "@/components/referral/top-referrers";
import { REFERRAL_LEADERBOARD_QUERY_KEY, ordinal, rankLabel } from "@/lib/referral-page";
import { clearPrerenderSeed, setPrerenderSeed } from "@/lib/seo/prerender-seed";

const ROWS = [
  { rank: 1, tied: true, display_name: "Ann", referrals: 4, credits_earned: 20 },
  { rank: 1, tied: true, display_name: "Bea", referrals: 4, credits_earned: 20 },
  { rank: 3, tied: false, display_name: "Cy", referrals: 1, credits_earned: 5 },
];

const fetchMock = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement;
let qc: QueryClient;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ referrers: ROWS }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  clearPrerenderSeed();
  vi.unstubAllGlobals();
});

async function render(seedKey?: string) {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <TopReferrers seedKey={seedKey} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("TopReferrers", () => {
  it("renders seeded rows on mount with no skeleton and no fetch", async () => {
    setPrerenderSeed("referral-leaderboard", { referrers: ROWS });
    await render("referral-leaderboard");
    expect(container.querySelector("[aria-busy=true]")).toBeNull();
    expect(container.querySelectorAll("ol > li")).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches when a save invalidates the board", async () => {
    await render();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await qc.invalidateQueries({ queryKey: REFERRAL_LEADERBOARD_QUERY_KEY });
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("labels ranks from the server, ties included", async () => {
    await render();
    await flush();
    const rows = Array.from(container.querySelectorAll("ol > li"));
    const labels = rows.map((li) => li.querySelector(".sr-only")?.textContent);
    expect(labels).toEqual(["Tied for 1st:", "Tied for 1st:", "Rank 3:"]);
    // No aria-label on the row: it would replace the name, count and credits
    // a screen reader reads from the row's own text.
    expect(rows.every((li) => !li.hasAttribute("aria-label"))).toBe(true);
    expect(rows[0]?.textContent).toContain("Ann");
    expect(container.textContent).not.toMatch(/CREDITS/);
  });
});

describe("rank words", () => {
  it("ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th",
    ]);
    expect(rankLabel(2, true)).toBe("Tied for 2nd");
    expect(rankLabel(2, false)).toBe("Rank 2");
  });
});
