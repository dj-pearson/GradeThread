// SRC-8: a Scout search is a durable, shareable question.
//  - the whole search lives in the URL, so a bookmark reopens it filled in;
//  - the last result survives a tab switch without a second paid scan;
//  - Demand's facets link to a URL Scout actually reads.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ edgeFetch: vi.fn() }));

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.edgeFetch }));
vi.mock("@/hooks/use-sourcing-settings", () => ({
  useSourcingSettings: () => ({ data: 30, isLoading: false, isError: false, isOwner: true, refetch: vi.fn() }),
}));
vi.mock("@/hooks/use-plan-usage", () => ({
  usePlanUsage: () => ({ aiActions: { used: 0, limit: 50, pct: 0, unlimited: false } }),
}));
vi.mock("@/components/flipdesk/forecast-card", () => ({ ForecastCard: () => null }));

const { FlipdeskScoutPage } = await import("@/pages/flipdesk/scout");
const { scoutHrefForFacet } = await import("@/lib/scout-links");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let location = "";

function Where() {
  const loc = useLocation();
  location = `${loc.pathname}${loc.search}`;
  return null;
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(url: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[url]}>
          <FlipdeskScoutPage />
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

const ROW = {
  itemId: "v1|123|0",
  title: "Patagonia Synchilla fleece",
  imageUrl: null,
  itemWebUrl: null,
  askingCents: 2400,
  shadowGrade: 8,
  gradeConfidence: 0.9,
  valueLowCents: 4000,
  valueMedianCents: 5000,
  valueHighCents: 6000,
  estMarginCents: 1500,
  estMarginPct: 0.6,
  underpriced: true,
  actionable: true,
  reason: "Underpriced for its condition.",
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.edgeFetch.mockReset().mockResolvedValue(
    new Response(JSON.stringify({ scanned: 1, considered: 10, graded: 1, candidates: [ROW] }), {
      status: 200,
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Scout search in the URL", () => {
  it("seeds keyword, brand and category from the URL and does not auto-run", async () => {
    await render("/dashboard/flipdesk/sourcing?tab=scout&q=fleece&brand=Patagonia&cat=57988");
    expect(value("scout-keyword")).toBe("fleece");
    expect(value("scout-brand")).toBe("Patagonia");
    expect(value("scout-category")).toBe("57988");
    expect(mocks.edgeFetch).not.toHaveBeenCalled();
  });

  it("an unknown ?sort= falls back to Best match", async () => {
    await render("/x?q=fleece&sort=cheapest-ever&freeShip=1");
    const sort = document.getElementById("scout-browse-sort") as HTMLSelectElement | null;
    // The sort select lives in the filter panel; open it if it is closed.
    if (!sort) {
      const toggle = Array.from(host.querySelectorAll("button")).find((b) =>
        /deal filter/i.test(b.textContent ?? ""),
      );
      await act(async () => toggle!.click());
    }
    expect((document.getElementById("scout-browse-sort") as HTMLSelectElement).value).toBe("bestMatch");
  });

  it("submit writes the words to the URL, and a remount shows the same rows with no second scan", async () => {
    await render("/dashboard/flipdesk/sourcing?tab=scout&q=fleece&brand=Patagonia&cat=57988");
    const form = host.querySelector("form")!;
    await act(async () => {
      form.requestSubmit();
    });
    await flush();
    expect(mocks.edgeFetch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Patagonia Synchilla fleece");
    const params = new URLSearchParams(location.split("?")[1]);
    expect(params.get("q")).toBe("fleece");
    expect(params.get("brand")).toBe("Patagonia");
    expect(params.get("cat")).toBe("57988");

    const after = location;
    act(() => root.unmount());
    root = createRoot(host);
    await render(after);
    expect(host.textContent).toContain("Patagonia Synchilla fleece");
    expect(mocks.edgeFetch).toHaveBeenCalledTimes(1);
  });

  it("a remount on a DIFFERENT search does not show the old rows", async () => {
    await render("/x?q=fleece");
    await act(async () => host.querySelector("form")!.requestSubmit());
    await flush();
    act(() => root.unmount());
    root = createRoot(host);
    await render("/x?q=denim");
    expect(host.textContent).not.toContain("Patagonia Synchilla fleece");
  });
});

describe("Demand links into Scout", () => {
  it("a brand facet prefills the brand, a category facet the words", () => {
    expect(scoutHrefForFacet("Patagonia", "brand")).toBe(
      "/dashboard/flipdesk/sourcing?tab=scout&brand=Patagonia",
    );
    expect(scoutHrefForFacet("fleece jackets", "category")).toBe(
      "/dashboard/flipdesk/sourcing?tab=scout&q=fleece+jackets",
    );
  });
});
