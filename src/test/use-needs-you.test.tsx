import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNeedsYou, type NeedsYouState } from "@/hooks/use-needs-you";
import { FlipdeskNeedsYouWidget } from "@/components/dashboard/widgets/flipdesk-needs-you";

// DASH-8: sellers with no eBay connection are not shown an eBay failure, and a
// slow eBay queue no longer hides rows that already loaded.

type Q = { data?: unknown; isLoading?: boolean; isError?: boolean };

const state = vi.hoisted(() => ({
  queues: {} as Record<string, Q>,
  enabledSeen: {} as Record<string, boolean[]>,
  refetched: [] as string[],
  connection: {} as { data?: unknown; isLoading?: boolean; isError?: boolean },
}));

function queryHook(name: string) {
  return (enabled = true) => {
    (state.enabledSeen[name] ??= []).push(enabled);
    const q = enabled ? (state.queues[name] ?? {}) : {};
    return {
      data: q.data,
      isLoading: enabled ? (q.isLoading ?? false) : false,
      isError: enabled ? (q.isError ?? false) : false,
      isFetching: false,
      refetch: vi.fn(() => {
        state.refetched.push(name);
      }),
    };
  };
}

vi.mock("@/hooks/use-ebay", () => ({
  useEbayReturns: queryHook("returns"),
  useEbayCancellations: queryHook("cancellations"),
  useEbayInquiries: queryHook("inquiries"),
  useEbayCases: queryHook("cases"),
  useEbayPaymentDisputes: queryHook("disputes"),
  useEbayBestOffers: queryHook("offers"),
  useEbayConnection: () => ({
    data: state.connection.data,
    isLoading: state.connection.isLoading ?? false,
    isError: state.connection.isError ?? false,
  }),
}));
vi.mock("@/hooks/use-ship-queue", () => ({
  useShipQueue: (enabled = true) => {
    const base = queryHook("shipments")(enabled);
    const rows = (base.data as unknown[] | undefined) ?? [];
    return { ...base, rows };
  },
}));

const SHIPMENT = {
  id: "s1",
  title: "Wool coat",
  orderRef: "O-1",
  shipBy: null,
  salePrice: 40,
};

let root: Root;
let container: HTMLDivElement;
let captured: NeedsYouState | null = null;

function Probe({ ebay }: { ebay: boolean }) {
  captured = useNeedsYou(true, ebay);
  return null;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.queues = {};
  state.enabledSeen = {};
  state.refetched = [];
  state.connection = { data: { id: "c" } };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useNeedsYou", () => {
  it("runs no eBay queue when eBay is off, and reports no partial failure", async () => {
    state.queues.shipments = { data: [] };
    await act(async () => root.render(<Probe ebay={false} />));
    for (const q of ["returns", "cancellations", "inquiries", "cases", "disputes", "offers"]) {
      expect(state.enabledSeen[q]!.every((e) => e === false), q).toBe(true);
    }
    expect(state.enabledSeen.shipments!.every((e) => e === true)).toBe(true);
    expect(captured!.isPartial).toBe(false);
    expect(captured!.isLoading).toBe(false);
  });

  it("retries only shipments when eBay is off", async () => {
    // refetch() runs a disabled query anyway. Retrying all seven for a seller
    // with no eBay connection fires six calls that each 502.
    state.queues.shipments = { data: [] };
    await act(async () => root.render(<Probe ebay={false} />));
    act(() => captured!.refetch());
    expect(state.refetched).toEqual(["shipments"]);
  });

  it("retries all seven when eBay is on", async () => {
    state.queues.shipments = { data: [] };
    await act(async () => root.render(<Probe ebay />));
    act(() => captured!.refetch());
    expect(state.refetched.sort()).toEqual(
      ["cancellations", "cases", "disputes", "inquiries", "offers", "returns", "shipments"],
    );
  });

  it("is not loading once any queue has answered, and names the rest", async () => {
    state.queues.shipments = { data: [SHIPMENT] };
    state.queues.returns = { isLoading: true };
    state.queues.cases = { isLoading: true };
    await act(async () => root.render(<Probe ebay />));
    expect(captured!.isLoading).toBe(false);
    expect(captured!.pending).toEqual(["returns", "cases"]);
    expect(captured!.items.map((i) => i.id)).toEqual(["s1"]);
  });

  it("is loading while no queue has answered", async () => {
    for (const q of ["returns", "cancellations", "inquiries", "cases", "disputes", "offers", "shipments"]) {
      state.queues[q] = { isLoading: true };
    }
    await act(async () => root.render(<Probe ebay />));
    expect(captured!.isLoading).toBe(true);
  });
});

describe("FlipdeskNeedsYouWidget", () => {
  async function renderWidget() {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <FlipdeskNeedsYouWidget size="md" range="d7" surface="flipdesk" />
        </MemoryRouter>,
      )
    );
  }

  it("shows the connect line and no partial warning without eBay", async () => {
    state.connection = { data: null };
    state.queues.shipments = { data: [] };
    await renderWidget();
    expect(container.textContent).toContain("Connect eBay");
    expect(container.textContent).not.toContain("did not answer");
    expect(state.enabledSeen.returns!.every((e) => e === false)).toBe(true);
  });

  it("renders loaded shipment rows while returns are still pending", async () => {
    state.queues.shipments = { data: [SHIPMENT] };
    state.queues.returns = { isLoading: true };
    await renderWidget();
    expect(container.textContent).toContain("Wool coat");
    expect(container.textContent).toContain("Still checking returns");
  });

  it("shows a skeleton while the connection is loading", async () => {
    state.connection = { isLoading: true };
    await renderWidget();
    expect(container.textContent).not.toContain("Connect eBay");
    expect(container.querySelector('[aria-busy="true"], [role="status"]')).not.toBeNull();
  });

  it("shows every row once all queues have loaded", async () => {
    state.queues.shipments = { data: [SHIPMENT] };
    for (const q of ["returns", "cancellations", "inquiries", "cases", "disputes", "offers"]) {
      state.queues[q] = { data: [] };
    }
    await renderWidget();
    expect(container.textContent).toContain("Wool coat");
    expect(container.textContent).not.toContain("Still checking");
  });
});
