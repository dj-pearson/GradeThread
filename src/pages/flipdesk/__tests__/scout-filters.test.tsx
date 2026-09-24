// SRC-9: the Scout form never waits on the profit-target read, and the deal
// filter in force is always visible.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { data: undefined as number | null | undefined, isLoading: true, isError: false },
  mutate: vi.fn(),
}));

vi.mock("@/hooks/use-sourcing-settings", () => ({
  useSourcingSettings: () => ({ ...mocks.settings, isOwner: true, refetch: vi.fn() }),
}));
vi.mock("@/hooks/use-scout", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-scout")>()),
  useScoutScan: () => ({ data: undefined, isPending: false, isError: false, mutate: mocks.mutate }),
}));
vi.mock("@/hooks/use-plan-usage", () => ({
  usePlanUsage: () => ({ aiActions: { used: 0, limit: 50, pct: 0, unlimited: false } }),
}));
vi.mock("@/components/flipdesk/forecast-card", () => ({ ForecastCard: () => null }));
vi.mock("@/components/flipdesk/sourcing-target-setting", async (orig) => ({
  ...(await orig<typeof import("@/components/flipdesk/sourcing-target-setting")>()),
  SourcingTargetSetting: () => null,
}));

const { FlipdeskScoutPage } = await import("@/pages/flipdesk/scout");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let search = "";

function Where() {
  search = useLocation().search;
  return null;
}

async function render(url: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[url]}>
          <FlipdeskScoutPage />
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const button = (text: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  mocks.settings = { data: undefined, isLoading: true, isError: false };
  mocks.mutate.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Scout deal filter", () => {
  it("renders Find deals while the target read never resolves", async () => {
    await render("/x");
    expect(button("Find deals")).toBeDefined();
    expect(host.textContent).not.toContain("Loading your profit target");
  });

  it("a failed target read is an inline alert with Retry, not a blank page", async () => {
    mocks.settings = { data: undefined, isLoading: false, isError: true };
    await render("/x?minMarginPct=40");
    expect(button("Find deals")).toBeDefined();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load your target, using 30%");
    expect(alert?.textContent).toContain("Retry");
  });

  it("?freeShip=1 opens the panel and the summary names it", async () => {
    await render("/x?freeShip=1");
    expect(document.getElementById("scout-max-total")).not.toBeNull();
    expect(host.querySelector('[data-testid="scout-filter-summary"]')?.textContent).toContain("free ship");
  });

  it("Clear removes every filter key from the URL", async () => {
    await render("/x?q=fleece&bin=1&freeShip=1&minMargin=20&maxTotal=40&minMarginPct=35&sort=priceAsc");
    await act(async () => button("Clear")!.click());
    const params = new URLSearchParams(search);
    for (const key of ["bin", "freeShip", "minMargin", "maxTotal", "minMarginPct", "sort"]) {
      expect(params.has(key), key).toBe(false);
    }
    expect(params.get("q")).toBe("fleece");
    expect(host.querySelector('[data-testid="scout-filter-summary"]')).toBeNull();
  });

  it("blank Min return says which target it uses, and sends it with the panel closed", async () => {
    mocks.settings = { data: 40, isLoading: false, isError: false };
    await render("/x?q=fleece");
    await act(async () => button("Deal filter")!.click());
    expect(host.textContent).toContain("Using your 40% target.");
    await act(async () => button("Hide deal filter")!.click());
    await act(async () => host.querySelector("form")!.requestSubmit());
    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ minMarginPct: 0.4 }));
  });

  it("the stored target in force shows beside a closed panel, with no Clear", async () => {
    mocks.settings = { data: 40, isLoading: false, isError: false };
    await render("/x?q=fleece");
    expect(document.getElementById("scout-max-total")).toBeNull();
    expect(host.querySelector('[data-testid="scout-filter-summary"]')?.textContent).toBe(
      "40%+ return (your target)",
    );
    expect(button("Clear")).toBeUndefined();
  });

  it("a failed target read is visible with the panel closed", async () => {
    mocks.settings = { data: undefined, isLoading: false, isError: true };
    await render("/x?q=fleece");
    expect(document.getElementById("scout-max-total")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load your target, using 30%",
    );
    expect(host.querySelector('[data-testid="scout-filter-summary"]')?.textContent).toBe(
      "30%+ return (default)",
    );
  });
});
