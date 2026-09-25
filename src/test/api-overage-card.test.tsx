// DEV-01: the overage card sells credits only a key with a monthly quota can
// spend. It must stay hidden until the usage route says one exists, and show
// the OWNER's balance as the edge reports it rather than reading a wallet row
// keyed on the viewer.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiOverageCard } from "@/components/api/api-overage-card";

const mocks = vi.hoisted(() => ({ usage: vi.fn() }));
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: async (path: string) => {
    if (path.startsWith("/api/keys/usage")) {
      return new Response(JSON.stringify({ data: mocks.usage() }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  },
}));
vi.mock("@/hooks/use-tenant-key", () => ({ useTenantKey: () => "owner" }));

function usage(overage: { quota_enabled: boolean; balance: number }) {
  return {
    summary: { since: "", days: 30, total_requests: 0, success_requests: 0, error_requests: 0, sandbox_requests: 0, by_endpoint: [], daily: [] },
    plan: "business",
    api_access: true,
    overage,
    rate_limits: { read_per_minute: 1, write_per_minute: 1, window_seconds: 60 },
  };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><ApiOverageCard /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

describe("ApiOverageCard", () => {
  it("renders nothing while no key carries a monthly quota", async () => {
    mocks.usage.mockReturnValue(usage({ quota_enabled: false, balance: 500 }));
    await render();
    expect(container.textContent).toBe("");
  });

  it("shows the owner's balance once a quota exists", async () => {
    mocks.usage.mockReturnValue(usage({ quota_enabled: true, balance: 27 }));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Balance: 27 credits"));
  });
});
