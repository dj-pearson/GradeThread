// DEV-14: the usage panel draws the 30-day series it always fetched, its stat
// parts add up to the total, a failed read offers Retry, and the writes label
// names every method the ledger counts as a write.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.fetch }));
vi.mock("@/hooks/use-tenant-key", () => ({ useTenantKey: () => "owner-1" }));

import { ApiUsagePanel } from "@/components/api/api-usage-panel";
import { zeroFillDaily } from "@/lib/api-usage-series";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function today(offset = 0): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - offset)).toISOString().slice(0, 10);
}

const USAGE = {
  summary: {
    since: "",
    days: 30,
    total_requests: 20,
    success_requests: 15,
    error_requests: 5,
    sandbox_requests: 6,
    by_endpoint: [],
    daily: [0, 1, 2, 5, 29].map((o, i) => ({ day: today(o), count: i + 1 })),
  },
  live_success_requests: 11,
  plan: "business",
  api_access: true,
  overage: { quota_enabled: false, balance: 0 },
  rate_limits: { read_per_minute: 120, write_per_minute: 30, window_seconds: 60 },
};

let respond: () => Response;
beforeEach(() => {
  respond = () => new Response(JSON.stringify({ data: USAGE }), { status: 200 });
  mocks.fetch.mockReset().mockImplementation(async () => respond());
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={qc}><ApiUsagePanel /></QueryClientProvider>));
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function stat(key: string): number {
  const el = container!.querySelector(`[data-stat="${key}"] dd`)!;
  return Number(el.textContent!.replace(/,/g, ""));
}

describe("ApiUsagePanel (DEV-14)", () => {
  it("a fixture with 5 daily rows draws 30 bars, zero-filled", async () => {
    await render();
    expect(container!.querySelectorAll('[data-testid="usage-bar"]')).toHaveLength(30);
    expect(container!.querySelectorAll("details tbody tr")).toHaveLength(30);
    const filled = zeroFillDaily(USAGE.summary.daily);
    expect(filled.filter((d) => d.count > 0)).toHaveLength(5);
    expect(filled[filled.length - 1]!.day).toBe(today(0));
  });

  it("Live success, Live errors and Sandbox sum to the total", async () => {
    await render();
    expect(stat("live-success") + stat("live-errors") + stat("sandbox")).toBe(stat("total"));
    expect(stat("total")).toBe(20);
  });

  it("the writes label names PUT and DELETE", async () => {
    await render();
    expect(container!.textContent).toContain("POST, PATCH, PUT, DELETE");
  });

  it("an error shows Try again, which refetches", async () => {
    respond = () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    await render();
    expect(container!.textContent).toContain("Couldn't load API usage");
    const before = mocks.fetch.mock.calls.length;
    respond = () => new Response(JSON.stringify({ data: USAGE }), { status: 200 });
    const retry = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.includes("Try again"))!;
    await act(async () => retry.click());
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(mocks.fetch.mock.calls.length).toBeGreaterThan(before);
    expect(container!.querySelectorAll('[data-testid="usage-bar"]')).toHaveLength(30);
  });

  it("a 403 shows the server's own message", async () => {
    respond = () => new Response(JSON.stringify({ error: "Only the workspace owner and admins can view API usage" }), { status: 403 });
    await render();
    expect(container!.textContent).toContain("Only the workspace owner and admins can view API usage");
    expect(container!.textContent).not.toContain("Try again");
  });
});
