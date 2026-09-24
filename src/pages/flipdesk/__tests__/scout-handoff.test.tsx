// SRC-13: every Scout row leads to an action. "Check in Buy decision" lands on
// Buy with the listing prefilled; "Bought it" logs the purchase with its cost,
// shadow grade, category, listing URL and Source. A row whose URL is not a
// real eBay https page renders no link at all.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE_ID = "0b8f7a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

const mocks = vi.hoisted(() => ({
  edgeFetch: vi.fn(),
  scanData: undefined as unknown,
  scanVars: undefined as unknown,
}));

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.edgeFetch }));
vi.mock("@/hooks/use-scout", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-scout")>()),
  useScoutScan: () => ({
    data: mocks.scanData,
    variables: mocks.scanVars,
    isPending: false,
    isError: false,
    mutate: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-sourcing-settings", () => ({
  useSourcingSettings: () => ({ data: 30, isLoading: false, isError: false, isOwner: true, refetch: vi.fn() }),
}));
vi.mock("@/hooks/use-plan-usage", () => ({
  usePlanUsage: () => ({ aiActions: { used: 0, limit: 50, pct: 0, unlimited: false } }),
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "owner-1", can: () => true }),
}));
vi.mock("@/hooks/use-sources", () => ({
  useSources: () => ({
    data: [{ id: SOURCE_ID, name: "Goodwill SE 14th", source_type: "thrift" }],
    isLoading: false,
  }),
}));
vi.mock("@/components/flipdesk/forecast-card", () => ({ ForecastCard: () => null }));
vi.mock("@/components/flipdesk/sourcing-target-setting", () => ({ SourcingTargetSetting: () => null }));

const { FlipdeskScoutPage } = await import("@/pages/flipdesk/scout");
const { FlipdeskScoutBuyPage } = await import("@/pages/flipdesk/scout-buy");
const { resolveSourcingTab } = await import("@/pages/flipdesk/nav-tabs");
const { useSearchParams } = await import("react-router");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A tiny stand-in for the Sourcing host: ?tab= picks the page.
function Host() {
  const [params] = useSearchParams();
  return resolveSourcingTab(params.get("tab")) === "buy" ? <FlipdeskScoutBuyPage /> : <FlipdeskScoutPage />;
}

let host: HTMLDivElement;
let root: Root;

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    itemId: "v1|123|0",
    title: "Patagonia Synchilla fleece",
    imageUrl: "https://i.ebayimg.com/x.jpg",
    itemWebUrl: "https://www.ebay.com/itm/123",
    askingCents: 2400,
    totalCents: 2900,
    shadowGrade: 8.5,
    gradeConfidence: 0.9,
    valueLowCents: 4000,
    valueMedianCents: 5000,
    valueHighCents: 6000,
    estMarginCents: 1500,
    estMarginPct: 0.6,
    underpriced: true,
    actionable: true,
    reason: "Underpriced for its condition.",
    ...over,
  };
}

async function render(url: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="*" element={<Host />} />
          </Routes>
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

beforeEach(() => {
  window.localStorage.setItem("gt.scout.lastSourceId.owner-1", SOURCE_ID);
  mocks.scanData = { scanned: 1, considered: 5, graded: 1, candidates: [row()] };
  mocks.scanVars = { categoryId: "57988", q: "fleece", brand: "Patagonia" };
  mocks.edgeFetch.mockReset().mockResolvedValue(
    new Response(JSON.stringify({ id: "item-9", status: "sourced" }), { status: 201 }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
});

const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

describe("Scout row handoff", () => {
  it("Check in Buy decision lands on Buy with the listing prefilled", async () => {
    await render("/dashboard/flipdesk/sourcing?tab=scout&q=fleece");
    const link = Array.from(host.querySelectorAll("a")).find((a) => a.textContent === "Check in Buy decision")!;
    await act(async () => link.click());
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(value("scout-keyword")).toBe("Patagonia Synchilla fleece");
    expect(value("scout-brand")).toBe("Patagonia");
    expect(value("scout-category")).toBe("57988");
    expect(value("scout-cost")).toBe("29.00");
    expect(host.textContent).toContain("Goodwill SE 14th");
  });

  it("Bought it sends the row's total, listing URL, grade, category and Source", async () => {
    await render("/dashboard/flipdesk/sourcing?tab=scout&q=fleece");
    const bought = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Bought it")!;
    await act(async () => bought.click());
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(mocks.edgeFetch).toHaveBeenCalledWith("/api/flipdesk/scout/buy", expect.anything());
    const body = mocks.edgeFetch.mock.calls[0]![1].json;
    expect(body.costCents).toBe(2900);
    expect(body.sourceListingUrl).toBe("https://www.ebay.com/itm/123");
    expect(body.gradeValue).toBe(8.5);
    expect(body.categoryId).toBe("57988");
    expect(body.sourceId).toBe(SOURCE_ID);
    expect(body.targetCents).toBe(5000);
  });

  it("a javascript: URL renders no link, and the thumbnail alt is empty", async () => {
    mocks.scanData = {
      scanned: 1,
      candidates: [row({ itemWebUrl: "javascript:alert(1)" })],
    };
    await render("/x?q=fleece");
    expect(Array.from(host.querySelectorAll("a")).some((a) => /View on eBay/.test(a.textContent ?? ""))).toBe(false);
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("the eBay link names the listing and says it opens a new tab", async () => {
    await render("/x?q=fleece");
    const link = Array.from(host.querySelectorAll("a")).find((a) => /View on eBay/.test(a.textContent ?? ""))!;
    expect(link.textContent).toContain("Patagonia Synchilla fleece (opens in new tab)");
  });
});
