// OM-05..08: the Best Offers panel under interaction.
//
// negotiation-tables.test.tsx covers first paint as static markup. These cover
// what happens when the seller presses things: closed offers have no buttons,
// a 409 removes the row, a loss or a decline asks first, an invalid counter
// cannot be sent, and a typed counter survives the row closing.
//
// The offers list is a REAL query on the real key, seeded in the cache with a
// queryFn that never settles, so the component's setQueryData is what is being
// tested rather than a mock of it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { EbayBestOffer } from "@/hooks/use-ebay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "tenant-1";
const NOW = Date.now();
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const mutateAsync = vi.fn();
const confirmMock = vi.fn();

vi.mock("@/hooks/use-tenant-key", () => ({ useTenantKey: () => TENANT }));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayBestOffers: () =>
    useQuery({
      queryKey: ["ebay_best_offers", TENANT],
      queryFn: () => new Promise<EbayBestOffer[]>(() => {}),
      staleTime: Infinity,
    }),
  useEbayRespondOffer: () => ({ isPending: false, variables: undefined, mutateAsync }),
  useEbayThresholdConflicts: () => ({ data: undefined }),
  resolveInventoryItemIdForEbayItem: async () => null,
}));
vi.mock("@/hooks/use-ai-extract", () => ({
  useNegotiationDraft: () => ({ isPending: false, mutateAsync: async () => null }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => confirmMock,
}));

const { BestOffersPanel } = await import("@/components/flipdesk/best-offers-table");

function offer(over: Partial<EbayBestOffer> & { bestOfferId: string }): EbayBestOffer {
  return {
    itemId: `9${over.bestOfferId.length}0001`,
    itemTitle: `Item ${over.bestOfferId}`,
    buyerUsername: "denimfan",
    price: 40,
    currency: "USD",
    listPriceCents: 5000,
    itemCost: 12,
    status: "Active",
    expiresAt: inHours(20),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let qc: QueryClient;

function render(offers: EbayBestOffer[]) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["ebay_best_offers", TENANT], offers);
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <BestOffersPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** The desktop table only; the phone cards render the same rows beside it. */
function table(): HTMLElement {
  return container!.querySelector("table") as HTMLElement;
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(label),
  ) as HTMLButtonElement | undefined;
}

function rowFor(title: string): HTMLTableRowElement {
  return [...table().querySelectorAll("tr")].find((tr) =>
    tr.textContent?.includes(title),
  ) as HTMLTableRowElement;
}

async function click(el: Element | undefined) {
  expect(el, "element to click").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function toggleRow(title: string) {
  act(() => {
    (rowFor(title).querySelector("button[aria-expanded]") as HTMLElement).click();
  });
}

beforeEach(() => {
  mutateAsync.mockReset();
  confirmMock.mockReset();
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("closed offers (OM-05)", () => {
  it("an expired offer shows no Accept button and is not counted as open", async () => {
    render([
      offer({ bestOfferId: "live", itemTitle: "Live jacket" }),
      offer({ bestOfferId: "dead", itemTitle: "Dead jacket", expiresAt: inHours(-2) }),
    ]);
    // Header counts the open one only.
    expect(container!.querySelector('[aria-label="1 open"]')).toBeTruthy();
    // Closed rows wait behind a toggle.
    expect(table().textContent).not.toContain("Dead jacket");
    await click(buttonIn(container!, "Show 1 closed"));
    const dead = rowFor("Dead jacket");
    expect(buttonIn(dead, "Accept")).toBeUndefined();
    expect(dead.textContent).toContain("Expired");
    expect(buttonIn(rowFor("Live jacket"), "Accept")).toBeTruthy();
  });

  it("a 409 offer_not_open removes the row without waiting for the poll", async () => {
    const err = Object.assign(new Error("gone"), { status: 409, code: "offer_not_open" });
    mutateAsync.mockRejectedValueOnce(err);
    render([offer({ bestOfferId: "a", itemTitle: "Gone jacket", itemCost: 1 })]);
    await click(buttonIn(rowFor("Gone jacket"), "Accept"));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(table()?.textContent ?? "").not.toContain("Gone jacket");
    expect(qc.getQueryData<EbayBestOffer[]>(["ebay_best_offers", TENANT])).toEqual([]);
  });
});

describe("accept and decline ask first (OM-06)", () => {
  it("a profitable accept fires at once, with no dialog", async () => {
    mutateAsync.mockResolvedValueOnce({ ok: true });
    render([offer({ bestOfferId: "a", itemTitle: "Good jacket", price: 40, itemCost: 5 })]);
    await click(buttonIn(rowFor("Good jacket"), "Accept"));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ bestOfferId: "a", action: "Accept" }),
    );
  });

  it("accepting at a loss opens the confirm with the dollar figure, and cancel sends nothing", async () => {
    confirmMock.mockResolvedValueOnce(false);
    render([
      offer({ bestOfferId: "a", itemTitle: "Loss jacket", price: 20, itemCost: 25 }),
    ]);
    await click(buttonIn(rowFor("Loss jacket"), "Accept"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const opts = confirmMock.mock.calls[0]![0] as { title: string; destructive: boolean };
    expect(opts.title).toMatch(/^Accepting loses \$\d+\.\d\d after fees and postage$/);
    expect(opts.destructive).toBe(true);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("an unknown cost asks too", async () => {
    confirmMock.mockResolvedValueOnce(false);
    render([offer({ bestOfferId: "a", itemTitle: "Mystery jacket", itemCost: null })]);
    await click(buttonIn(rowFor("Mystery jacket"), "Accept"));
    expect(confirmMock.mock.calls[0]![0].title).toBe("We don't know this item's cost");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("decline always confirms", async () => {
    confirmMock.mockResolvedValueOnce(true);
    mutateAsync.mockResolvedValueOnce({ ok: true });
    render([offer({ bestOfferId: "a", itemTitle: "Any jacket", itemCost: 1 })]);
    await click(buttonIn(rowFor("Any jacket"), "Decline"));
    expect(confirmMock.mock.calls[0]![0].title).toBe("Decline $40.00 from denimfan?");
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ action: "Decline" }));
  });
});

describe("the counter form (OM-07, OM-08)", () => {
  function counterInput(): HTMLInputElement {
    return table().querySelector('input[aria-label="Counter offer price"]') as HTMLInputElement;
  }

  it("an invalid counter shows the reason and cannot be sent", () => {
    render([offer({ bestOfferId: "a", itemTitle: "Form jacket" })]);
    toggleRow("Form jacket");
    type(counterInput(), "38");
    expect(counterInput().getAttribute("aria-invalid")).toBe("true");
    expect(table().textContent).toContain("more than the buyer's $40.00");
    expect(buttonIn(table(), "Send counter")!.disabled).toBe(true);
    type(counterInput(), "45");
    expect(buttonIn(table(), "Send counter")!.disabled).toBe(false);
  });

  it("sends the offer's own quantity", async () => {
    mutateAsync.mockResolvedValueOnce({ ok: true });
    render([offer({ bestOfferId: "a", itemTitle: "Three jackets", quantity: 3 })]);
    toggleRow("Three jackets");
    type(counterInput(), "45");
    await click(buttonIn(table(), "Send counter"));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ action: "Counter", counterPrice: 45, counterQuantity: 3 }),
    );
  });

  it("a typed counter survives the row closing and another opening, and a send clears it", async () => {
    render([
      offer({ bestOfferId: "a", itemTitle: "First jacket" }),
      offer({ bestOfferId: "b", itemTitle: "Second jacket", expiresAt: inHours(30) }),
    ]);
    toggleRow("First jacket");
    type(counterInput(), "44.50");
    // Open another row, which closes the first.
    toggleRow("Second jacket");
    expect(rowFor("First jacket").textContent).toContain("Draft");
    toggleRow("First jacket");
    expect(counterInput().value).toBe("44.50");
    // The phone card tree reads the same draft, so crossing md keeps it.
    const card = container!.querySelector(
      '.md\\:hidden input[aria-label="Counter offer price"]',
    ) as HTMLInputElement;
    expect(card.value).toBe("44.50");

    mutateAsync.mockResolvedValueOnce({ ok: true });
    await click(buttonIn(table(), "Send counter"));
    expect(counterInput().value).toBe("");
  });
});
