import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { needsYouHref } from "@/hooks/use-needs-you";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

// DASH-15: a Needs-you row links to the exact item, and the post-sale page
// lands on it.

const state = vi.hoisted(() => ({
  cancellations: [] as Array<Record<string, unknown>>,
  items: [] as Array<{ id: string; kind: string }>,
}));

vi.mock("@/hooks/use-needs-you", async (original) => ({
  ...(await original<typeof import("@/hooks/use-needs-you")>()),
  useNeedsYou: () => ({
    items: state.items,
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
  const query = (data: unknown) => () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
  useEbayConnection: query({ id: "conn" }),
  useEbayCancellations: () => ({ data: state.cancellations, isLoading: false }),
  useEbayCases: query([]),
  useEbayPaymentDisputes: query([]),
  useEbayInquiries: query([]),
  useEbayReturns: query([]),
  useEbayOrderTotal: query(null),
  useEbayReadReturnShipment: query(null),
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
  Element.prototype.scrollIntoView = vi.fn();
  state.cancellations = [
    { cancelId: "c-1", state: "OPEN", orderId: "O-1", reason: "BUYER_ASKED", requestorType: "BUYER", creationDate: null },
    { cancelId: "c-2", state: "OPEN", orderId: "O-2", reason: "OUT_OF_STOCK", requestorType: "BUYER", creationDate: null },
  ];
  state.items = [
    { id: "c-1", kind: "cancellation" },
    { id: "c-2", kind: "cancellation" },
  ];
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

async function renderAt(url: string) {
  const { FlipdeskPostSalePage } = await import("@/pages/flipdesk/post-sale");
  const router = createMemoryRouter(
    [{ path: "/dashboard/flipdesk/post-sale", element: <FlipdeskPostSalePage /> }],
    { initialEntries: [url] },
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
  return router;
}

describe("needsYouHref", () => {
  it("names the exact item and its tab", () => {
    expect(needsYouHref({ kind: "return", id: "r 9" })).toBe(
      "/dashboard/flipdesk/post-sale?tab=returns&focus=r%209",
    );
    expect(needsYouHref({ kind: "inquiry", id: "i1" })).toBe(
      "/dashboard/flipdesk/post-sale?tab=cases&focus=i1",
    );
    expect(needsYouHref({ kind: "offer", id: "o1" })).toBe(
      "/dashboard/flipdesk/offers?focus=o1",
    );
  });
});

describe("post-sale ?focus=", () => {
  it("opens the item's tab, then highlights and focuses its row", async () => {
    // No tab in the link: the page works it out from the item's kind.
    const router = await renderAt("/dashboard/flipdesk/post-sale?focus=c-2");
    await vi.waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get("tab")).toBe(
        "cancellations",
      )
    );
    await vi.waitFor(() => {
      const row = container.querySelector('[data-focus-id="c-2"]');
      expect(row?.getAttribute("data-focused")).toBe("true");
      expect(document.activeElement).toBe(row);
    });
    expect(container.querySelector('[data-focus-id="c-1"]')!.hasAttribute("data-focused"))
      .toBe(false);
  });

  it("says so when the item is no longer open", async () => {
    await renderAt("/dashboard/flipdesk/post-sale?tab=cancellations&focus=gone");
    await vi.waitFor(() =>
      expect(container.textContent).toContain("This case is no longer open")
    );
  });
});
