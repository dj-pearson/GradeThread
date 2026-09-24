// PS-13: the grade pack stays in view while the seller writes the argument,
// the dispute buttons name their order, and a failing auto-check does not loop.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

const state = vi.hoisted(() => ({
  previewCalls: 0,
  previewRejects: false,
  resolveRejects: false,
  resolveCalls: 0,
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

vi.mock("@/hooks/use-ebay", async () => {
  const { useState } = await import("react");
  const ok = (data: unknown) => () => ({
    data,
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  });
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  const dispute = {
    paymentDisputeId: "D-1",
    orderId: "ORDER-9",
    status: "OPEN",
    reason: "SIGNIFICANTLY_NOT_AS_DESCRIBED",
    amount: 40,
    currency: "USD",
    openedDate: null,
    respondByDate: null,
    buyerUsername: null,
  };
  return {
    useEbayConnection: ok({ id: "conn" }),
    useEbayCancellations: ok([]),
    useEbayCases: ok([]),
    useEbayPaymentDisputes: ok([dispute]),
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
    useEbayResolveDispute: () => ({
      mutateAsync: () => {
        state.resolveCalls += 1;
        return state.resolveRejects
          ? Promise.reject(new Error("eBay said no"))
          : Promise.resolve({ ok: true });
      },
      isPending: false,
    }),
    // A real state change per call, the way useMutation re-renders, so a
    // dependency on the mutation object would re-run an effect.
    useEbayReturnEvidencePlan: () => {
      const [, setN] = useState(0);
      return {
        mutateAsync: () => {
          state.previewCalls += 1;
          setN((n) => n + 1);
          const settled = state.previewRejects
            ? Promise.reject(new Error("down"))
            : Promise.resolve({ available: true, verdict: "contradicted", citations: [] });
          // useMutation re-renders again when the call settles.
          settled.catch(() => {}).finally(() => setN((n) => n + 1));
          return settled;
        },
        isPending: false,
      };
    },
    useEbaySendReturnEvidence: mutation,
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

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.previewCalls = 0;
  state.previewRejects = false;
  state.resolveRejects = false;
  state.resolveCalls = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function renderDisputes() {
  const { FlipdeskPostSalePage } = await import("@/pages/flipdesk/post-sale");
  const router = createMemoryRouter(
    [{ path: "/dashboard/flipdesk/post-sale", element: <FlipdeskPostSalePage /> }],
    { initialEntries: ["/dashboard/flipdesk/post-sale?tab=disputes"] },
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
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("contesting with the grade pack in view (PS-13)", () => {
  it("names the order in the accept button's accessible name", async () => {
    await renderDisputes();
    expect(byLabel("Accept and refund order ORDER-9")).toBeTruthy();
    expect(byLabel("Contest the dispute on order ORDER-9")).toBeTruthy();
  });

  it("shows the evidence verdict inside the open Contest dialog", async () => {
    await renderDisputes();
    await act(async () => byLabel("Contest the dispute on order ORDER-9")!.click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Your listing disclosed this");
    // And no second pack sits under the modal.
    expect(container.textContent).not.toContain("Your listing disclosed this");
  });

  it("runs a rejecting auto-check exactly once", async () => {
    state.previewRejects = true;
    await renderDisputes();
    await act(async () => byLabel("Contest the dispute on order ORDER-9")!.click());
    await settle();
    await settle();
    expect(state.previewCalls).toBe(1);
  });

  it("keeps the dialog and the note when the contest fails", async () => {
    state.resolveRejects = true;
    await renderDisputes();
    await act(async () => byLabel("Contest the dispute on order ORDER-9")!.click());
    const note = document.getElementById("contest-note") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(note, "Tracking shows delivered.");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === "Contest dispute")!;
    await act(async () => submit.click());
    await settle();
    expect(state.resolveCalls).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect((document.getElementById("contest-note") as HTMLTextAreaElement).value)
      .toBe("Tracking shows delivered.");
  });
});
