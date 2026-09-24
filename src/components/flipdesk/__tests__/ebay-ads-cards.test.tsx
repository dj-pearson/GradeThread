// The Ads-tab cards, mounted against a stubbed edge.
//
// MP-02: the money-moving buttons follow the edge role floors, so a member is
// never offered an action the server will refuse.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  role: "owner" as string,
  routes: {} as Record<string, { status: number; body: unknown }>,
  calls: [] as Array<{ path: string; method: string }>,
};

vi.mock("@/hooks/use-workspace", async () => {
  const perms = await import("@/lib/workspace-permissions");
  return {
    useWorkspace: () => ({
      role: state.role,
      workspaceOwnerId: "owner-1",
      can: (cap: Parameters<typeof perms.canDo>[1]) =>
        perms.canDo(state.role as Parameters<typeof perms.canDo>[0], cap),
    }),
  };
});

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: vi.fn(async (path: string, init?: RequestInit) => {
    state.calls.push({ path, method: init?.method ?? "GET" });
    const hit = Object.entries(state.routes).find(([p]) => path.startsWith(p));
    const { status, body } = hit ? hit[1] : { status: 404, body: { error: "not stubbed" } };
    return new Response(JSON.stringify(body), { status });
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: "owner-1" }, activeWorkspaceOwnerId: null }),
}));

const { EbayCampaignCard } = await import("@/components/flipdesk/ebay-campaign-card");
const { EbayKeywordsCard } = await import("@/components/flipdesk/ebay-keywords-card");
const { FollowerCampaignCard } = await import("@/components/flipdesk/follower-campaign-card");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(container!);
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  // Let the stubbed fetches resolve and the queries settle.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return container!;
}

function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

const SUGGESTIONS = {
  campaign: { campaignId: "c1" },
  supported: true,
  items: [],
};
const KEYWORDS = {
  campaignId: "c1",
  adGroupId: "g1",
  keywords: [],
  negatives: [],
  negativeCandidates: [{ term: "free", clicks: 9, impressions: 90, reason: "9 clicks" }],
};
const EMAILS = {
  available: true,
  campaigns: [{ campaignId: "e1", name: "Spring", status: "DRAFT", recipientCount: 3 }],
};

beforeEach(() => {
  state.role = "owner";
  state.calls = [];
  state.routes = {
    "/api/flipdesk/ebay/marketing/suggestions": { status: 200, body: SUGGESTIONS },
    "/api/flipdesk/ebay/marketing/keywords/suggestions": {
      status: 200,
      body: { suggestions: [] },
    },
    "/api/flipdesk/ebay/marketing/keywords": { status: 200, body: KEYWORDS },
    "/api/flipdesk/ebay/marketing/email-campaigns": { status: 200, body: EMAILS },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("MP-02: role floors on the Ads cards", () => {
  it("a member cannot pause, resume or end the campaign", async () => {
    state.role = "member";
    await render(<EbayCampaignCard />);
    expect(button("End")?.disabled).toBe(true);
    expect(button("Pause")?.disabled).toBe(true);
    expect(button("End")?.title).toContain("Admin");
  });

  it("a listing_manager can block a search but cannot end the campaign", async () => {
    state.role = "listing_manager";
    await render(
      <>
        <EbayCampaignCard />
        <EbayKeywordsCard />
      </>,
    );
    expect(button("End")?.disabled).toBe(true);
    expect(button("Block")?.disabled).toBe(false);
  });

  it("a member cannot block a search", async () => {
    state.role = "member";
    await render(<EbayKeywordsCard />);
    expect(button("Block")?.disabled).toBe(true);
  });

  it("only an admin can send a follower email", async () => {
    state.role = "listing_manager";
    await render(<FollowerCampaignCard />);
    expect(button("Send")?.disabled).toBe(true);
  });

  it("an admin can end the campaign and send", async () => {
    state.role = "admin";
    await render(
      <>
        <EbayCampaignCard />
        <FollowerCampaignCard />
      </>,
    );
    expect(button("End")?.disabled).toBe(false);
    expect(button("Send")?.disabled).toBe(false);
  });
});

describe("MP-03: no campaign means Start one, never a silent create", () => {
  it("the campaign card offers Start one and hides Pause/End when there is no campaign", async () => {
    state.routes["/api/flipdesk/ebay/marketing/suggestions"] = {
      status: 200,
      body: { supported: true, campaign: null, items: [] },
    };
    await render(<EbayCampaignCard />);
    expect(document.body.textContent).toContain("No cost-per-click campaign yet");
    expect(button("End")).toBeUndefined();
    expect(button("Start one")).toBeTruthy();
    // Nothing was POSTed just by rendering.
    expect(state.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("Start one posts to campaign/start", async () => {
    state.routes["/api/flipdesk/ebay/marketing/suggestions"] = {
      status: 200,
      body: { supported: true, campaign: null, items: [] },
    };
    state.routes["/api/flipdesk/ebay/marketing/campaign/start"] = {
      status: 200,
      body: { ok: true },
    };
    await render(<EbayCampaignCard />);
    await act(async () => {
      button("Start one")!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(state.calls).toContainEqual({
      path: "/api/flipdesk/ebay/marketing/campaign/start",
      method: "POST",
    });
  });

  it("the keywords card says there is no campaign yet", async () => {
    state.routes["/api/flipdesk/ebay/marketing/keywords"] = {
      status: 200,
      body: {
        campaign: null,
        campaignId: null,
        adGroupId: null,
        keywords: [],
        negatives: [],
        negativeCandidates: [],
      },
    };
    await render(<EbayKeywordsCard />);
    expect(document.body.textContent).toContain("No cost-per-click campaign yet");
    expect(button("Start one")).toBeTruthy();
  });
});
