import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

// PS-01: a failed eBay read is never shown as "nothing waiting".
//
// Each card used to default a failed list to [] and draw its "No open ..."
// copy. This renders the real page with one list query rejected at a time and
// requires the error line and a Retry that calls refetch once.

type Q = {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
  isSuccess?: boolean;
  source?: string | null;
};

const state = vi.hoisted(() => ({
  queries: {} as Record<string, Q>,
  refetches: {} as Record<string, number>,
}));

vi.mock("@/hooks/use-needs-you", async (original) => ({
  ...(await original<typeof import("@/hooks/use-needs-you")>()),
  useNeedsYou: () => ({
    items: [],
    queues: {},
    pending: [],
    isLoading: false,
    isError: false,
    isPartial: false,
    isFetching: false,
    refetch: () => {},
  }),
}));

vi.mock("@/hooks/use-ebay", () => {
  const list = (name: string) => () => {
    const q = state.queries[name] ?? { data: [], isSuccess: true };
    return {
      data: q.data,
      isLoading: q.isLoading ?? false,
      isError: q.isError ?? false,
      isSuccess: q.isSuccess ?? false,
      source: q.source ?? null,
      dataUpdatedAt: Date.parse("2026-09-24T09:05:00"),
      refetch: vi.fn(() => {
        state.refetches[name] = (state.refetches[name] ?? 0) + 1;
      }),
    };
  };
  const query = (data: unknown) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useEbayConnection: query({ id: "conn" }),
    useEbayCancellations: list("cancellations"),
    useEbayCases: list("cases"),
    useEbayPaymentDisputes: list("disputes"),
    useEbayInquiries: list("inquiries"),
    useEbayReturns: list("returns"),
    useEbayOrderTotal: query(null),
    useEbayReadReturnShipment: mutation,
    useEbayCaseAction: mutation,
    useEbayDecideCancellation: mutation,
    useEbayAddDisputeEvidence: mutation,
    useEbayDecideReturn: mutation,
    useEbayInquiryAction: mutation,
    useEbayIssueOrderRefund: mutation,
    useEbayMarkReturnReceived: mutation,
    useEbaySendReturnMessage: mutation,
    useEbayRefundReturn: mutation,
    useEbayResolveDispute: mutation,
  };
});
vi.mock("@/hooks/use-case-items", () => ({
  caseItemKey: () => "k",
  ebayOrderUrl: () => "#",
  ebayReturnUrl: () => "#",
  useCaseItems: () => ({ data: undefined }),
}));
vi.mock("@/components/flipdesk/ship-queue-card", () => ({ ShipQueueCard: () => null }));
vi.mock("@/components/flipdesk/return-analytics-card", () => ({ ReturnAnalyticsCard: () => null }));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.queries = {};
  state.refetches = {};
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

async function renderTab(tab: string) {
  const { FlipdeskPostSalePage } = await import("@/pages/flipdesk/post-sale");
  const router = createMemoryRouter(
    [{ path: "/dashboard/flipdesk/post-sale", element: <FlipdeskPostSalePage /> }],
    { initialEntries: [`/dashboard/flipdesk/post-sale?tab=${tab}`] },
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </QueryClientProvider>,
    )
  );
}

const CASES: Array<{ query: string; tab: string; kind: string; empty: string }> = [
  { query: "disputes", tab: "disputes", kind: "payment disputes", empty: "No open payment disputes." },
  { query: "returns", tab: "returns", kind: "returns", empty: "No open returns." },
  { query: "cancellations", tab: "cancellations", kind: "cancellation requests", empty: "No open cancellation requests." },
  { query: "inquiries", tab: "cases", kind: "item-not-received inquiries", empty: "No open item-not-received inquiries." },
  { query: "cases", tab: "cases", kind: "eBay cases", empty: "No open eBay cases." },
];

describe("post-sale cards on a failed eBay read (PS-01)", () => {
  for (const c of CASES) {
    it(`${c.query}: says it could not reach eBay, never "${c.empty}"`, async () => {
      state.queries[c.query] = { data: undefined, isError: true, isSuccess: false };
      await renderTab(c.tab);
      const text = container.textContent ?? "";
      expect(text).toContain(`Couldn't reach eBay. Your ${c.kind} may not be shown.`);
      expect(text).not.toContain(c.empty);

      const alert = [...container.querySelectorAll('[role="alert"]')].find((el) =>
        el.textContent?.includes(c.kind)
      );
      const retry = [...(alert?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "Retry",
      );
      expect(retry).toBeTruthy();
      await act(async () => retry!.click());
      expect(state.refetches[c.query]).toBe(1);
    });
  }

  it("a read that succeeded with nothing open still says so", async () => {
    state.queries.returns = { data: [], isSuccess: true };
    await renderTab("returns");
    expect(container.textContent).toContain("No open returns.");
    expect(container.textContent).not.toContain("Couldn't reach eBay");
  });

  it("a read still loading shows neither the empty copy nor the error", async () => {
    state.queries.returns = { data: undefined, isLoading: true };
    await renderTab("returns");
    expect(container.textContent).not.toContain("No open returns.");
    expect(container.textContent).not.toContain("Couldn't reach eBay");
  });
});

describe("a saved copy is labelled (PS-12)", () => {
  const ret = {
    returnId: "r-1",
    state: "RETURN_REQUESTED",
    orderId: "O-1",
    itemId: null,
    reason: "NO_LONGER_NEED_ITEM",
    creationDate: null,
    respondBy: null,
    buyerUsername: null,
  };

  it("shows the banner and the rows when the edge served cache_stale", async () => {
    state.queries.returns = { data: [ret], isSuccess: true, source: "cache_stale" };
    await renderTab("returns");
    const text = container.textContent ?? "";
    expect(text).toContain("eBay didn't answer. Showing a saved copy from");
    expect(text).toContain("deadlines may have moved");
    expect(container.querySelector('[data-focus-id="r-1"]')).toBeTruthy();
  });

  it("shows no banner on a live answer", async () => {
    state.queries.returns = { data: [ret], isSuccess: true, source: "ebay" };
    await renderTab("returns");
    expect(container.textContent).not.toContain("saved copy");
    expect(container.querySelector('[data-focus-id="r-1"]')).toBeTruthy();
  });
});
