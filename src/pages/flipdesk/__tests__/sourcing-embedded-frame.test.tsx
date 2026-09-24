// SRC-11: inside the Sourcing host, Scout, Buy decision and Buyer demand defer
// to the host's one content frame. Each used to add its own max width and
// gutter, so the left edge jumped on every tab switch, and the embed context
// dropped the subtitles that carried Buy's instructions and Demand's count.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageHostContext } from "@/hooks/use-page-host";

vi.mock("@/hooks/use-sourcing-settings", () => ({
  useSourcingSettings: () => ({ data: 30, isLoading: false, isError: false, isOwner: true, refetch: vi.fn() }),
  SOURCING_SETTINGS_KEY: "sourcing_settings",
  parseTargetPct: () => null,
}));
vi.mock("@/hooks/use-plan-usage", () => ({
  usePlanUsage: () => ({ aiActions: { used: 0, limit: 50, pct: 0, unlimited: false } }),
}));
vi.mock("@/components/flipdesk/forecast-card", () => ({ ForecastCard: () => null }));
vi.mock("@/hooks/use-flipdesk-demand", () => ({
  useFlipdeskDemand: () => ({
    demand: {
      totalWants: 7,
      brands: [{ term: "Patagonia", wantCount: 4, topMinGrade: null, topMaxPriceCents: null }],
      categories: [],
    },
    isLoading: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-sources", () => ({
  useSources: () => ({ data: [], isLoading: false }),
}));

const { FlipdeskScoutPage } = await import("@/pages/flipdesk/scout");
const { FlipdeskScoutBuyPage } = await import("@/pages/flipdesk/scout-buy");
const { FlipdeskDemandPage } = await import("@/pages/flipdesk/demand");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode, embedded: boolean) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <PageHostContext.Provider value={{ embedded }}>{node}</PageHostContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

function rootClasses(): string[] {
  return (host.firstElementChild?.className ?? "").split(/\s+/);
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

const PAGES: [string, () => React.ReactNode][] = [
  ["Scout", () => <FlipdeskScoutPage />],
  ["Buy decision", () => <FlipdeskScoutBuyPage />],
  ["Buyer demand", () => <FlipdeskDemandPage />],
];

describe("embedded Sourcing tabs share the host frame", () => {
  for (const [name, page] of PAGES) {
    it(`${name}: no page gutter or width when embedded`, async () => {
      await render(page(), true);
      const classes = rootClasses();
      for (const bad of ["p-6", "p-4", "py-8", "sm:p-6", "mx-auto"]) {
        expect(classes, `${name} root carries ${bad}`).not.toContain(bad);
      }
      expect(classes.some((c) => c.startsWith("max-w-")), `${name} root sets a max width`).toBe(false);
    });
  }

  it("Buyer demand still says how many open wants there are when embedded", async () => {
    await render(<FlipdeskDemandPage />, true);
    expect(host.textContent).toContain("7 open wants");
  });

  it("Buy decision keeps its instructions when embedded", async () => {
    await render(<FlipdeskScoutBuyPage />, true);
    expect(host.textContent).toContain("In the field, before you buy");
  });

  it("standalone pages keep their own frame", async () => {
    await render(<FlipdeskScoutPage />, false);
    expect(rootClasses()).toContain("max-w-4xl");
  });
});
