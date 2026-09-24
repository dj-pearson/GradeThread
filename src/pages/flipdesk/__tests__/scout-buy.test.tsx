// SRC-12: Buy decision sends what was appraised, including the category; aims
// only at a sufficient value; warns at the grading contract's 0.75 line; and
// after "Bought it" says where the item went and resets for the next one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appraiseData: undefined as unknown,
  variables: {} as Record<string, unknown>,
  buyMutate: vi.fn(),
  buyState: { isPending: false, isSuccess: false, data: undefined as { id: string } | undefined },
  reset: vi.fn(),
}));

vi.mock("@/hooks/use-scout-appraise", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-scout-appraise")>()),
  useScoutAppraise: () => ({
    data: mocks.appraiseData,
    variables: mocks.variables,
    isPending: false,
    isError: false,
    mutate: vi.fn(),
    reset: mocks.reset,
  }),
  useScoutBuy: () => ({ ...mocks.buyState, mutate: mocks.buyMutate }),
}));
vi.mock("@/components/flipdesk/sourcing-target-setting", () => ({ SourcingTargetSetting: () => null }));

const { FlipdeskScoutBuyPage } = await import("@/pages/flipdesk/scout-buy");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function result(over: { sufficient?: boolean; confidence?: number; needsHumanReview?: boolean } = {}) {
  return {
    grade: {
      value: 8,
      tier: "Excellent",
      confidence: over.confidence ?? 0.9,
      needsHumanReview: over.needsHumanReview ?? false,
      imagesAnalyzed: 1,
    },
    value: {
      lowCents: 3000,
      medianCents: 4000,
      highCents: 5000,
      sampleSize: 12,
      confidence: 0.8,
      sufficient: over.sufficient ?? true,
      currency: "USD",
    },
    sellThrough: { sellThroughPct: 0.5, daysLow: 7, daysHigh: 21, label: "moderate", sampleSize: 12 },
    costCents: 800,
    decision: {
      recommendation: "buy",
      estProceedsCents: 3300,
      estMarginCents: 2500,
      roiPct: 3.1,
      breakevenCents: 900,
      reason: "Good margin.",
      confident: true,
    },
    matchedTitle: null,
    identityIsAuthoritative: false,
    matchedCategoryId: "57988",
  };
}

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <FlipdeskScoutBuyPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const button = (text: RegExp) =>
  Array.from(host.querySelectorAll("button")).find((b) => text.test(b.textContent ?? ""));

beforeEach(() => {
  mocks.appraiseData = result();
  mocks.variables = { q: "Patagonia fleece", brand: "Patagonia", size: "M", categoryId: "11450" };
  mocks.buyMutate.mockReset();
  mocks.reset.mockReset();
  mocks.buyState = { isPending: false, isSuccess: false, data: undefined };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Buy decision", () => {
  it("sends the matched category and the appraised words", async () => {
    await render();
    await act(async () => button(/Bought it/)!.click());
    const body = mocks.buyMutate.mock.calls[0]![0];
    expect(body.categoryId).toBe("57988");
    expect(body.title).toBe("Patagonia fleece");
    expect(body.brand).toBe("Patagonia");
    expect(body.targetCents).toBe(4000);
  });

  it("aims at no price when the comps were thin", async () => {
    mocks.appraiseData = result({ sufficient: false });
    await render();
    await act(async () => button(/Bought it/)!.click());
    expect(mocks.buyMutate.mock.calls[0]![0].targetCents).toBeUndefined();
  });

  it("warns at confidence 0.7, and when the engine flagged review", async () => {
    mocks.appraiseData = result({ confidence: 0.7 });
    await render();
    expect(host.textContent).toContain("Low grade confidence (70%)");
    mocks.appraiseData = result({ confidence: 0.9, needsHumanReview: true });
    await render();
    expect(host.textContent).toContain("Low grade confidence (90%)");
  });

  it("does not warn at 0.9 with no review flag", async () => {
    await render();
    expect(host.textContent).not.toContain("Low grade confidence");
  });

  it("after Bought it, Open item goes to the new item and Next item resets", async () => {
    mocks.buyState = { isPending: false, isSuccess: true, data: { id: "item-123" } };
    await render();
    const open = Array.from(host.querySelectorAll("a")).find((a) => a.textContent === "Open item");
    expect(open?.getAttribute("href")).toBe("/dashboard/flipdesk/items/item-123");
    await act(async () => button(/^Next item$/)!.click());
    expect(mocks.reset).toHaveBeenCalled();
  });
});
