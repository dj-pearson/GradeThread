// PS-11: each tab's badge speaks for its own queues. With the ship queue
// answered and returns still in flight, Returns shows a loading marker rather
// than no badge (which reads as "nothing waiting").
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

const state = vi.hoisted(() => ({
  queues: {} as Record<string, { isLoading: boolean; isError: boolean }>,
  items: [] as Array<{ id: string; kind: string; deadline: string | null }>,
  refetches: 0,
}));

vi.mock("@/hooks/use-needs-you", async (original) => ({
  ...(await original<typeof import("@/hooks/use-needs-you")>()),
  useNeedsYou: () => {
    const pending = Object.entries(state.queues).filter(([, q]) => q.isLoading).map(([k]) => k);
    return {
      items: state.items,
      queues: state.queues,
      pending,
      isLoading: false,
      isError: false,
      isPartial: Object.values(state.queues).some((q) => q.isError),
      isFetching: false,
      refetch: () => {
        state.refetches += 1;
      },
    };
  },
}));

vi.mock("@/hooks/use-ebay", () => {
  const ok = (data: unknown) => () => ({
    data,
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  });
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useEbayConnection: ok({ id: "conn" }),
    useEbayCancellations: ok([]),
    useEbayCases: ok([]),
    useEbayPaymentDisputes: ok([]),
    useEbayInquiries: ok([]),
    useEbayReturns: ok([]),
    useEbayOrderTotal: ok(null),
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

const ready = { isLoading: false, isError: false };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.queues = {
    shipments: ready,
    returns: ready,
    cancellations: ready,
    inquiries: ready,
    cases: ready,
    disputes: ready,
  };
  state.items = [];
  state.refetches = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(url = "/dashboard/flipdesk/post-sale?tab=ship") {
  const { FlipdeskPostSalePage } = await import("@/pages/flipdesk/post-sale");
  const router = createMemoryRouter(
    [{ path: "/dashboard/flipdesk/post-sale", element: <FlipdeskPostSalePage /> }],
    { initialEntries: [url] },
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </QueryClientProvider>,
    )
  );
  return router;
}

function tab(label: string): HTMLElement {
  const el = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
    t.textContent?.startsWith(label)
  );
  if (!el) throw new Error(`no tab ${label}`);
  return el;
}

describe("post-sale tab markers (PS-11)", () => {
  it("shows loading on Returns while returns is pending and ship has answered", async () => {
    state.queues.returns = { isLoading: true, isError: false };
    state.items = [{ id: "s1", kind: "shipment", deadline: null }];
    await render();
    expect(tab("Returns").textContent).toContain("loading");
    expect(tab("Ship").textContent).toContain("1");
    expect(tab("Ship").textContent).toContain("waiting on you");
  });

  it("marks a failed queue's tab and names it above the tabs, with Retry", async () => {
    state.queues.disputes = { isLoading: false, isError: true };
    await render();
    expect(tab("Disputes").textContent).toContain("could not load");
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("payment disputes");
    const retry = [...alert.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(state.refetches).toBe(1);
  });

  it("an answered zero shows no badge and no marker", async () => {
    await render();
    expect(tab("Returns").textContent).toBe("Returns");
  });
});

describe("opening tab and the all-clear line (PS-15)", () => {
  it("opens the most urgent tab when the link names none", async () => {
    state.items = [
      { id: "d1", kind: "dispute", deadline: "2026-09-25T00:00:00.000Z" },
      { id: "s1", kind: "shipment", deadline: null },
    ];
    const router = await render("/dashboard/flipdesk/post-sale");
    expect(router.state.location.search).toContain("tab=disputes");
  });

  it("keeps an explicit ?tab=", async () => {
    state.items = [{ id: "d1", kind: "dispute", deadline: null }];
    const router = await render("/dashboard/flipdesk/post-sale?tab=returns");
    expect(router.state.location.search).toContain("tab=returns");
  });

  it("maps an old #anchor to its tab", async () => {
    const router = await render("/dashboard/flipdesk/post-sale#payment-disputes");
    expect(router.state.location.search).toContain("tab=disputes");
  });

  it("says nothing is waiting only when every queue answered with zero", async () => {
    await render();
    const status = [...container.querySelectorAll('[role="status"]')].map((e) => e.textContent);
    expect(status.some((t) => t?.startsWith("Nothing is waiting on you. Checked"))).toBe(true);
  });

  it("does not say all clear while a queue is loading", async () => {
    state.queues.returns = { isLoading: true, isError: false };
    await render();
    expect(container.textContent).not.toContain("Nothing is waiting on you");
  });

  it("does not say all clear while a queue has failed", async () => {
    state.queues.cases = { isLoading: false, isError: true };
    await render();
    expect(container.textContent).not.toContain("Nothing is waiting on you");
  });

  it("counts what is waiting and names the soonest date", async () => {
    state.items = [
      { id: "d1", kind: "dispute", deadline: "2026-09-25T12:00:00.000Z" },
      { id: "s1", kind: "shipment", deadline: null },
    ];
    await render();
    expect(container.textContent).toContain("2 things need you, the soonest due");
  });
});
