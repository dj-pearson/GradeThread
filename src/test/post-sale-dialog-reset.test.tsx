import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

// PS-02: the tracking dialog and the appeal box start fresh for each case.
//
// Both kept their text in state that outlived the case they were opened for,
// so inquiry B opened with inquiry A's tracking number and Send enabled, and
// case B opened with case A's appeal argument.

const state = vi.hoisted(() => ({
  inquiries: [] as Array<Record<string, unknown>>,
  cases: [] as Array<Record<string, unknown>>,
  caseItems: undefined as Map<string, Record<string, unknown>> | undefined,
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
  const ok = (data: unknown) => ({
    data,
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  });
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useEbayConnection: () => ok({ id: "conn" }),
    useEbayCancellations: () => ok([]),
    useEbayCases: () => ok(state.cases),
    useEbayPaymentDisputes: () => ok([]),
    useEbayInquiries: () => ok(state.inquiries),
    useEbayReturns: () => ok([]),
    useEbayOrderTotal: () => ok(null),
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
  caseItemKey: (k: { orderId: string | null }) => k.orderId,
  ebayOrderUrl: () => "#",
  ebayReturnUrl: () => "#",
  useCaseItems: () => ({ data: state.caseItems }),
}));
vi.mock("@/components/flipdesk/ship-queue-card", () => ({ ShipQueueCard: () => null }));
vi.mock("@/components/flipdesk/return-analytics-card", () => ({ ReturnAnalyticsCard: () => null }));
vi.mock("@/components/flipdesk/return-evidence-panel", () => ({ ReturnEvidencePanel: () => null }));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function inquiry(id: string, orderId: string) {
  return {
    inquiryId: id,
    state: "OPEN",
    orderId,
    itemId: null,
    reason: "ITEM_NOT_RECEIVED",
    buyerUsername: null,
    respondBy: null,
    creationDate: null,
  };
}

function kase(id: string, orderId: string) {
  return {
    caseId: id,
    state: "OPEN",
    orderId,
    itemId: null,
    reason: "OTHER",
    buyerUsername: null,
    respondBy: null,
    creationDate: null,
    escalatedFrom: null,
    amountCents: null,
    currency: null,
  };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.inquiries = [inquiry("inq-A", "ORDER-A"), inquiry("inq-B", "ORDER-B")];
  state.cases = [kase("case-A", "ORDER-C"), kase("case-B", "ORDER-D")];
  state.caseItems = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  document.body.innerHTML = "";
});

async function renderCases() {
  const { FlipdeskPostSalePage } = await import("@/pages/flipdesk/post-sale");
  const router = createMemoryRouter(
    [{ path: "/dashboard/flipdesk/post-sale", element: <FlipdeskPostSalePage /> }],
    { initialEntries: ["/dashboard/flipdesk/post-sale?tab=cases"] },
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

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function byLabel(label: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`no button labelled ${label}`);
  return el;
}

function buttonByText(text: string): HTMLButtonElement {
  const el = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`no dialog button ${text}`);
  return el;
}

describe("post-sale dialogs reset per case (PS-02)", () => {
  it("the tracking dialog opens empty for the next inquiry", async () => {
    await renderCases();
    await act(async () => byLabel("Add tracking for order ORDER-A").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("ORDER-A");
    type(document.getElementById("po-tracking") as HTMLInputElement, "1Z999AA10123456784");
    const carrier = document.getElementById("po-carrier") as HTMLInputElement | HTMLSelectElement;
    if (carrier instanceof HTMLInputElement) type(carrier, "UPS");
    expect(buttonByText("Send tracking").disabled).toBe(false);

    await act(async () => buttonByText("Cancel").click());
    await act(async () => byLabel("Add tracking for order ORDER-B").click());

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("ORDER-B");
    expect((document.getElementById("po-tracking") as HTMLInputElement).value).toBe("");
    expect(buttonByText("Send tracking").disabled).toBe(true);
  });

  it("the appeal box opens empty for the next case", async () => {
    await renderCases();
    await act(async () => byLabel("Appeal case case-A").click());
    const box = () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your appeal argument"]')!;
    type(box(), "Tracking shows delivered.");
    expect(box().value).toBe("Tracking shows delivered.");

    await act(async () => buttonByText("Cancel").click());
    await act(async () => byLabel("Appeal case case-B").click());

    expect(box().value).toBe("");
    expect(buttonByText("Submit appeal").disabled).toBe(true);
  });
});

describe("INR tracking from the Ship tab (PS-14)", () => {
  it("starts prefilled, with Send enabled, when the sale already has tracking", async () => {
    state.caseItems = new Map([
      ["ORDER-A", {
        inventoryItemId: "item-1",
        title: "Wool coat",
        salePrice: 40,
        acquiredPrice: null,
        thumbnailUrl: null,
        ebayItemId: null,
        trackingNumber: "9400100000000000000000",
        carrier: "usps",
        shippedAt: "2026-09-20T15:00:00.000Z",
      }],
    ]);
    await renderCases();
    await act(async () => byLabel("Add tracking for order ORDER-A").click());
    expect((document.getElementById("po-tracking") as HTMLInputElement).value)
      .toBe("9400100000000000000000");
    expect((document.getElementById("po-carrier") as HTMLSelectElement).value).toBe("USPS");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("From your Ship tab, shipped");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Wool coat");
    expect(buttonByText("Send tracking").disabled).toBe(false);
  });

  it("keeps a carrier outside the pick list by name, under Other", async () => {
    state.caseItems = new Map([
      ["ORDER-A", {
        inventoryItemId: "item-1",
        title: "Wool coat",
        salePrice: 40,
        acquiredPrice: null,
        thumbnailUrl: null,
        ebayItemId: null,
        trackingNumber: "RN123456789GB",
        carrier: "Royal Mail",
        shippedAt: null,
      }],
    ]);
    await renderCases();
    await act(async () => byLabel("Add tracking for order ORDER-A").click());
    expect((document.getElementById("po-carrier") as HTMLSelectElement).value).toBe("Other");
    const name = document.getElementById("po-carrier-other") as HTMLInputElement;
    expect(name.value).toBe("Royal Mail");
    expect(buttonByText("Send tracking").disabled).toBe(false);
    // "Other" with no name is not a carrier eBay can check a number against.
    type(name, "");
    expect(buttonByText("Send tracking").disabled).toBe(true);
  });

  it("starts empty when the sale has no tracking", async () => {
    await renderCases();
    await act(async () => byLabel("Add tracking for order ORDER-B").click());
    expect((document.getElementById("po-tracking") as HTMLInputElement).value).toBe("");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("From your Ship tab");
    expect(buttonByText("Send tracking").disabled).toBe(true);
  });
});
