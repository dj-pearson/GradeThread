// PS-10: fast tracking entry. The carrier is read off the number's shape,
// Enter ships the row (a barcode scanner types the number and presses Enter),
// and the print count is the ticked rows still in the queue.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectCarrier,
  normalizeTracking,
  stripUspsZipPrefix,
} from "@/pages/flipdesk/ship-queue";

describe("detectCarrier", () => {
  it("reads one sample per carrier", () => {
    expect(detectCarrier("1Z999AA10123456784")).toBe("UPS");
    expect(detectCarrier("9400 1000 0000 0000 0000 00")).toBe("USPS");
    expect(detectCarrier("420902109400100000000000000000")).toBe("USPS");
    expect(detectCarrier("123456789012")).toBe("FedEx");
    expect(detectCarrier("1234567890")).toBe("DHL");
  });

  it("returns null for a shape it does not know", () => {
    expect(detectCarrier("ABC-123")).toBeNull();
    expect(detectCarrier("")).toBeNull();
  });

  it("normalizes spaces and case, and drops the 420+ZIP prefix", () => {
    expect(normalizeTracking(" 1z 999aa1 ")).toBe("1Z999AA1");
    expect(stripUspsZipPrefix("420 90210 9400100000000000000000")).toBe("9400100000000000000000");
    expect(stripUspsZipPrefix("1Z999AA10123456784")).toBe("1Z999AA10123456784");
  });
});

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  shipped: [] as Array<Record<string, unknown>>,
  ebayPushes: 0,
  pushError: null as (Error & { status?: number }) | null,
}));

vi.mock("@/hooks/use-ship-queue", () => ({
  useShipQueue: () => ({
    rows: state.rows,
    data: state.rows,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayShipOrder: () => ({
    mutateAsync: async () => {
      state.ebayPushes += 1;
      return { ok: true, pushed_to_ebay: true };
    },
    isPending: false,
  }),
}));
vi.mock("@/lib/ship-sale", () => ({
  shipSale: async (input: Record<string, unknown>) => {
    state.shipped.push(input);
    return { itemError: null };
  },
  markItemShipped: async () => null,
  pushMarketplaceShip: async () => {
    if (state.pushError) throw state.pushError;
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    orderRef: null,
    shipBy: null,
    soldAt: null,
    buyerUsername: null,
    salePrice: 20,
    inventoryItemId: `item-${id}`,
    title: `Coat ${id}`,
    sku: null,
    size: null,
    locationBin: null,
    container: null,
    listingUrl: null,
    costBasis: null,
    net: null,
    gradeValue: null,
    gradeLabel: null,
    certificateUrl: null,
    quantity: 1,
    platform: null,
    ...over,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.rows = [row("a"), row("b"), row("c")];
  state.shipped = [];
  state.ebayPushes = 0;
  state.pushError = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  const { ShipQueueCard } = await import("@/components/flipdesk/ship-queue-card");
  const client = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ShipQueueCard />
      </QueryClientProvider>,
    )
  );
}

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const tracking = (name: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="Tracking number for ${name}"]`)!;

describe("ShipQueueCard entry (PS-10)", () => {
  it("prefills the carrier from the number", async () => {
    await render();
    type(tracking("Coat a"), "1Z999AA10123456784");
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Carrier for Coat a"]')!;
    expect(select.value).toBe("UPS");
  });

  it("Enter in the tracking box ships the row", async () => {
    await render();
    const input = tracking("Coat a");
    type(input, "9400 1000 0000 0000 0000 00");
    const form = input.closest("form")!;
    expect(form).toBeTruthy();
    // jsdom does not implement a browser's implicit submission, so the Enter
    // is delivered as the submit the browser would fire for it.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      form.requestSubmit();
    });
    expect(state.shipped).toHaveLength(1);
    expect(state.shipped[0]).toMatchObject({
      saleId: "a",
      tracking: "9400100000000000000000",
      carrier: "USPS",
    });
    expect(state.ebayPushes).toBe(0);
  });

  it("the print count is the ticked rows still in the queue", async () => {
    await render();
    const all = container.querySelector<HTMLButtonElement>('button[aria-label="Select all orders"]')!;
    await act(async () => all.click());
    const print = () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Print packing slips"))!;
    expect(print().textContent).toContain("(3)");

    // Row b ships and leaves the queue; its tick must not be counted.
    state.rows = [row("a"), row("c")];
    await render();
    expect(print().textContent).toContain("(2)");
    expect(all.getAttribute("aria-checked")).toBe("true");
  });

  it("the header box reads mixed when only some rows are ticked", async () => {
    await render();
    const one = container.querySelector<HTMLButtonElement>('button[aria-label="Select Coat a for a packing slip"]')!;
    await act(async () => one.click());
    const all = container.querySelector<HTMLButtonElement>('button[aria-label="Select all orders"]')!;
    expect(all.getAttribute("aria-checked")).toBe("mixed");
  });
});

describe("focus after a ship (PS-10)", () => {
  it("moves to the next row's tracking box once the shipped row leaves", async () => {
    await render();
    const input = tracking("Coat a");
    type(input, "1Z999AA10123456784");
    await act(async () => input.closest("form")!.requestSubmit());
    state.rows = [row("b"), row("c")];
    await render();
    expect(document.activeElement).toBe(tracking("Coat b"));
  });
});

describe("a refused Shopify or Depop push", () => {
  it("records the shipment here and says the marketplace has no tracking", async () => {
    const { toast } = await import("sonner");
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
    state.rows = [row("a", { platform: "shopify", orderRef: "5550001" })];
    state.pushError = Object.assign(new Error("Shopify is not connected."), { status: 409 });
    await render();
    const input = tracking("Coat a");
    type(input, "1Z999AA10123456784");
    await act(async () => input.closest("form")!.requestSubmit());
    // The row still leaves the queue through the local write.
    expect(state.shipped).toHaveLength(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.warning).mock.calls[0]![1]?.description ?? "")).toContain("Shopify");
  });
});
