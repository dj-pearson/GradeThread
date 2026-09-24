// OM-11..13: the Offers & Messages page shell, the Send tab and the
// auto-accept conflict banner.
//
// Every hook is mocked: these are about what the page does with a result
// (an error, a revoked token, a discount, a partial send), not the fetches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  today: { available: true, candidates: [], suppressed: [] } as Record<string, unknown>,
  connection: {} as Record<string, unknown>,
  issue: null as null | { is_active: boolean; refresh_error: string | null },
  eligible: [] as Array<Record<string, unknown>>,
  conflicts: {} as Record<string, unknown>,
};
const sendMutate = vi.fn();
const confirmMock = vi.fn();
const refetchConnection = vi.fn();
const refetchConflicts = vi.fn();

vi.mock("@/hooks/use-ebay", () => ({
  useEbayConnection: () => state.connection,
  useEbayConnectionIssue: () => ({ data: state.issue }),
  isReauthNeeded: (i: { is_active: boolean; refresh_error: string | null } | null) =>
    !!i && !i.is_active && !!i.refresh_error && i.refresh_error !== "disconnected",
  reauthMessage: () => "Your eBay sign-in expired or was revoked.",
  useEbayBestOffers: () => ({ data: [], isLoading: false, isError: false }),
  useEbayMessages: () => ({ data: [], isLoading: false, isError: false }),
  useEbayNegotiationCapability: () => ({
    data: { sendOfferAvailable: true, code: null, detail: null },
    isLoading: false,
  }),
  useEbayEligibleOffers: () => ({
    data: state.eligible,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isFetching: false,
  }),
  useEbaySendOffer: () => ({ isPending: false, mutateAsync: sendMutate }),
  useEbaySendOffersToday: () => ({
    data: state.today,
    isLoading: false,
    isError: false,
  }),
  useEbayThresholdConflicts: () => state.conflicts,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => confirmMock,
}));
// The panels on the other tabs are covered by their own tests.
vi.mock("@/components/flipdesk/best-offers-table", () => ({ BestOffersPanel: () => null }));
vi.mock("@/components/flipdesk/buyer-messages-table", () => ({
  BuyerMessagesPanel: () => null,
}));
vi.mock("@/components/flipdesk/offer-analytics-card", () => ({
  OfferAnalyticsCard: () => null,
}));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));

const { FlipdeskOffersPage } = await import("@/pages/flipdesk/offers");
const { OfferThresholdConflicts } = await import(
  "@/components/flipdesk/offer-threshold-conflicts"
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode, url = "/dashboard/flipdesk/offers") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Exact text first, because "Send offer" is also the start of the tab "Send offers". */
function button(label: string): HTMLButtonElement | undefined {
  const all = [...container!.querySelectorAll("button")];
  return (all.find((b) => b.textContent?.trim() === label) ??
    all.find((b) => b.textContent?.trim().startsWith(label))) as HTMLButtonElement | undefined;
}

async function click(el: Element | undefined) {
  expect(el, "element to click").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const connected = {
  data: { id: "c1" },
  isLoading: false,
  isError: false,
  refetch: refetchConnection,
  isFetching: false,
};

beforeEach(() => {
  sendMutate.mockReset();
  confirmMock.mockReset();
  refetchConnection.mockReset();
  refetchConflicts.mockReset();
  state.connection = connected;
  state.issue = null;
  state.eligible = [];
  state.today = { available: true, candidates: [], suppressed: [] };
  state.conflicts = { data: undefined, isError: false, refetch: refetchConflicts };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("page shell (OM-11)", () => {
  it("a failed connection check offers Retry, never Connect", async () => {
    state.connection = {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchConnection,
      isFetching: false,
    };
    render(<FlipdeskOffersPage />);
    expect(container!.textContent).toContain("We could not check your eBay connection");
    expect(container!.textContent).not.toContain("Go to Marketplaces");
    expect(container!.textContent).not.toContain("Connect eBay");
    // The shell still carries the header.
    expect(container!.textContent).toContain("Offers & Messages");
    await click(button("Try again"));
    expect(refetchConnection).toHaveBeenCalled();
  });

  it("a revoked token gets reconnect copy, not first-time copy", () => {
    state.connection = { ...connected, data: null };
    state.issue = { is_active: false, refresh_error: "token revoked" };
    render(<FlipdeskOffersPage />);
    expect(container!.textContent).toContain("Reconnect eBay");
    expect(container!.textContent).toContain("expired or was revoked");
  });

  it("links are SPA links, not full reloads", () => {
    state.connection = { ...connected, data: null };
    render(<FlipdeskOffersPage />);
    const link = container!.querySelector('a[href="/dashboard/flipdesk/marketplaces"]');
    expect(link).toBeTruthy();
  });

  it("each section is a real tab panel", () => {
    render(<FlipdeskOffersPage />, "/dashboard/flipdesk/offers?tab=send");
    const panel = container!.querySelector('[role="tabpanel"]');
    expect(panel).toBeTruthy();
    const tab = document.getElementById(panel!.getAttribute("aria-labelledby")!);
    expect(tab?.getAttribute("aria-controls")).toBe(panel!.id);
  });
});

describe("Send tab (OM-12)", () => {
  const items = [
    { listingId: "111", title: "Denim jacket", price: 50, currency: "USD" },
    { listingId: "222", title: "Flannel", price: 30, currency: "USD" },
  ];

  function discountInput(): HTMLInputElement {
    return container!.querySelector("#offers-discount") as HTMLInputElement;
  }

  it("prefills the discount from ?discount=", () => {
    state.today = {
      available: true,
      candidates: [
        { listingId: "9", title: "Watched", priceCents: 4000, watchers: 3, daysListed: 9, lastOfferedAt: null },
      ],
      suppressed: [],
    };
    render(<FlipdeskOffersPage />, "/dashboard/flipdesk/offers?tab=send&discount=12");
    expect(discountInput().value).toBe("12");
    expect((container!.querySelector("#offer-discount") as HTMLInputElement).value).toBe("12");
  });

  it("shows the discounted price on each row", () => {
    state.eligible = items;
    render(<FlipdeskOffersPage />, "/dashboard/flipdesk/offers?tab=send");
    expect(container!.textContent).toContain("$50.00 -> $45.00");
  });

  it("0.4 disables Send, and 75 says the range instead of sending 60", () => {
    state.eligible = items;
    render(<FlipdeskOffersPage />, "/dashboard/flipdesk/offers?tab=send");
    act(() => {
      (container!.querySelector('[role="checkbox"]') as HTMLElement).click();
    });
    typeInto(discountInput(), "0.4");
    expect(button("Send offer")!.disabled).toBe(true);
    typeInto(discountInput(), "75");
    expect(container!.textContent).toContain("Offers go from 1% to 60%.");
    expect(button("Send offer")!.disabled).toBe(true);
    typeInto(discountInput(), "10");
    expect(button("Send 10% off to 1")!.disabled).toBe(false);
  });

  it("a manual send confirms with the exposure total first", async () => {
    state.eligible = items;
    confirmMock.mockResolvedValueOnce(false);
    render(<FlipdeskOffersPage />, "/dashboard/flipdesk/offers?tab=send");
    for (const box of container!.querySelectorAll('[role="checkbox"]')) {
      act(() => (box as HTMLElement).click());
    }
    await click(button("Send 10% off to 2"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const opts = confirmMock.mock.calls[0]![0] as { title: string; description: string };
    expect(opts.title).toBe("Send 10% off to 2 listings?");
    // 10% of $50 + 10% of $30.
    expect(opts.description).toContain("$8.00");
    expect(sendMutate).not.toHaveBeenCalled();
  });

  it("a partial send keeps only the failures selected", async () => {
    state.eligible = items;
    confirmMock.mockResolvedValueOnce(true);
    sendMutate.mockResolvedValueOnce({
      ok: false,
      count: 1,
      sent: ["111"],
      failed: [{ ids: ["222"], detail: "eBay said no." }],
    });
    render(<FlipdeskOffersPage />, "/dashboard/flipdesk/offers?tab=send");
    for (const box of container!.querySelectorAll('[role="checkbox"]')) {
      act(() => (box as HTMLElement).click());
    }
    await click(button("Send 10% off to 2"));
    expect(sendMutate).toHaveBeenCalledWith(
      expect.objectContaining({ listingIds: ["111", "222"], discountPct: 10 }),
    );
    expect(button("Send 10% off to 1")).toBeTruthy();
  });
});

describe("threshold conflicts (OM-13)", () => {
  it("a failed check says so and offers Retry", async () => {
    state.conflicts = { data: undefined, isError: true, refetch: refetchConflicts };
    render(<OfferThresholdConflicts />);
    expect(container!.textContent).toContain("Couldn't check eBay auto-accept against your rule");
    await click(button("Retry"));
    expect(refetchConflicts).toHaveBeenCalled();
  });

  it("Raise asks first, with the count and the biggest change", async () => {
    confirmMock.mockResolvedValueOnce(false);
    state.conflicts = {
      isError: false,
      refetch: refetchConflicts,
      data: {
        rule: { id: "r1", accept_at_pct: 85, margin_floor_pct: 10 },
        conflicts: [
          {
            listing_id: "l1",
            title: "A",
            stored_auto_accept_cents: 1800,
            rule_auto_accept_cents: 2450,
            reason: "raised_to_rule",
          },
          {
            listing_id: "l2",
            title: "B",
            stored_auto_accept_cents: 1000,
            rule_auto_accept_cents: 1100,
            reason: "raised_to_rule",
          },
        ],
      },
    };
    render(<OfferThresholdConflicts />);
    await click(button("Raise them to match my rule"));
    const opts = confirmMock.mock.calls[0]![0] as { title: string; description: string };
    expect(opts.title).toBe("Raise 2 listings?");
    expect(opts.description).toContain("Biggest change: $18.00 to $24.50");
  });
});
