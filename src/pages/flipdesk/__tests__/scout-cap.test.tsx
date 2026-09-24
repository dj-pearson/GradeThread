// SRC-3: a scan the AI cap stopped says so. It used to come back as an empty
// list and the page told the seller "No listings matched that search", which
// sends them to fix a search that was fine.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("@/hooks/use-scout", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-scout")>()),
  useScoutScan: () => ({
    data: mocks.data,
    isPending: false,
    isError: false,
    mutate: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-sourcing-settings", () => ({
  useSourcingSettings: () => ({ data: 30, isLoading: false, isError: false, isOwner: true, refetch: vi.fn() }),
}));
vi.mock("@/hooks/use-plan-usage", () => ({
  usePlanUsage: () => ({ aiActions: { used: 40, limit: 50, pct: 80, unlimited: false } }),
}));
vi.mock("@/components/flipdesk/forecast-card", () => ({ ForecastCard: () => null }));

const { FlipdeskScoutPage } = await import("@/pages/flipdesk/scout");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <FlipdeskScoutPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Scout scan cost and cap", () => {
  it("an empty cap-stopped scan shows the cap line, not 'No listings matched'", async () => {
    mocks.data = {
      scanned: 0,
      candidates: [],
      capReached: true,
      note: "AI limit reached after grading 0 of 8. Upgrade or wait for the reset.",
    };
    await render();
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toContain("AI limit reached after grading 0 of 8");
    expect(host.textContent).not.toContain("No listings matched");
    expect(host.textContent).not.toContain("No candidates found");
  });

  it("says what a scan costs before the click", async () => {
    mocks.data = undefined;
    await render();
    expect(host.textContent).toContain("Uses up to 8 AI actions, 10 left this month");
  });
});
