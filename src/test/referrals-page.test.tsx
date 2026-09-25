// The Referrals page: each inner tab is a URL, Stripe's return lands on the
// Affiliate tab once and cleans up after itself, the leaderboard copy is
// honest, and the user-facing strings carry no em dash.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const calls: string[] = [];
let me: Record<string, unknown> = {};
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: async (url: string) => {
    calls.push(url);
    if (url === "/api/referrals/me") return new Response(JSON.stringify(me), { status: 200 });
    if (url === "/api/referrals/me/events") {
      return new Response(JSON.stringify({ events: [], truncated: false }), { status: 200 });
    }
    if (url === "/api/affiliate/connect/status") {
      return new Response(JSON.stringify({ connected: true, payouts_enabled: true }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 500 });
  },
}));
const toastSuccess = vi.fn();
const toastPlain = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign((...a: unknown[]) => toastPlain(...a), {
    error: vi.fn(),
    success: (...a: unknown[]) => toastSuccess(...a),
  }),
}));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://functions.example.test" }));

import { ReferralsPage } from "@/pages/referrals";

const ME = {
  code: "ABCD2345",
  stats: { total: 0, pending: 0, qualified: 0, granted: 0, waiting: 0, forfeit: 0 },
  credits: { per_referral: 5, earned: 0, pending: 0 },
  rules: { per_referral: 5, referred_bonus: 3, referred_on_qualify: 3, window_days: 0, cap: 0, cap_remaining: null },
  milestones: { tiers: [], earned_thresholds: [], earned_bonus_credits: 0, next: null },
  leaderboard: { enabled: false, display_name: null, rank: null, tied: false },
  referred_by: null,
  redeem_eligible: true,
};

let root: Root | null = null;
let container: HTMLDivElement;
let location = "";

function LocationSpy() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  return null;
}

beforeEach(() => {
  calls.length = 0;
  toastSuccess.mockReset();
  toastPlain.mockReset();
  me = ME;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ referrers: [] }), { status: 200 })));
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <ReferralsPage />
          <LocationSpy />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const activeTab = () =>
  container.querySelector('[role="tab"][data-state="active"]')?.textContent ?? "";

describe("Referrals sections", () => {
  it("?connect=done opens Affiliate, toasts once and strips the param", async () => {
    await render("/dashboard/referrals?connect=done");
    expect(activeTab()).toBe("Affiliate");
    expect(calls.filter((u) => u === "/api/affiliate/connect/status")).toHaveLength(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Payouts are on.");
    expect(location).toBe("/dashboard/referrals?section=affiliate");
  });

  it("?section=leaderboard opens the Leaderboard tab", async () => {
    await render("/dashboard/account?tab=referrals&section=leaderboard");
    expect(activeTab()).toBe("Leaderboard");
  });

  it("an unknown section falls back to Share", async () => {
    await render("/dashboard/account?tab=referrals&section=nope");
    expect(activeTab()).toBe("Share");
  });

  it("an opted-in seller with no rewarded referral is told when they will appear", async () => {
    me = { ...ME, leaderboard: { enabled: true, display_name: "ThriftKing", rank: null, tied: false } };
    await render("/dashboard/account?tab=referrals&section=leaderboard");
    expect(container.textContent).toContain("You'll appear once your first referral is rewarded.");
    expect(container.textContent).not.toContain("You're visible");
  });

  it("a listed seller sees their rank", async () => {
    me = { ...ME, leaderboard: { enabled: true, display_name: "ThriftKing", rank: 12, tied: false } };
    await render("/dashboard/account?tab=referrals&section=leaderboard");
    expect(container.textContent).toContain("You're #12.");
  });

  it("explains the deal with the live numbers", async () => {
    await render("/dashboard/account?tab=referrals");
    const text = container.textContent ?? "";
    expect(text).toContain("Your friend gets 3 free grades when they join.");
    expect(text).toContain("You get 5 credits after their first paid grade.");
  });
});

describe("referrals copy", () => {
  it("the page's strings contain no em dash", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/referrals.tsx"), "utf8");
    // Comments may say what they like; strings and JSX text may not.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("—");
  });
});
