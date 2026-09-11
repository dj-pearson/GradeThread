// US-3376 AC5, rank 1: "Marked shipped" while the garment never leaves the ship
// queue.
//
// ShipOrderDialog.submit() does up to three writes. The `sales` write is checked
// and throws. The status write that moves the item to the Shipped tab was not
// checked at all, and that asymmetry is what made it invisible: eBay had the
// tracking, the sale recorded shipped_at, the toast said "Marked shipped", the
// dialog closed, and the garment sat in the ship queue forever.
//
// So the dialog is MOUNTED and the failure is driven through the real button.
// The assertion is the toast the seller reads and whether the dialog closed -
// not that `error` was destructured, which is the check this class of bug walks
// straight past.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// -- supabase ----------------------------------------------------------------
// The sale lookup answers a MANUAL sale (platform_order_id null), so submit()
// takes the local-record branch and never touches the eBay ship route. That
// isolates the one write under test.
let salesUpdateError: unknown = null;
let statusUpdateError: unknown = null;
const writes: { table: string; patch: Record<string, unknown> }[] = [];

vi.mock("@/lib/supabase", () => {
  const saleRow = { id: "sale-1", platform_order_id: null };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: saleRow, error: null }),
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          // Resolves with { error }. A PostgrestFilterBuilder never rejects,
          // which is why the surrounding try/catch could not see this.
          eq: () => {
            writes.push({ table, patch });
            return Promise.resolve({
              data: null,
              error: table === "sales" ? salesUpdateError : statusUpdateError,
            });
          },
        }),
      }),
    },
  };
});

// -- toasts ------------------------------------------------------------------
const successes: string[] = [];
const warnings: { fallback?: string; nextStep?: string }[] = [];
const errors: { fallback?: string }[] = [];

vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => successes.push(m),
    error: (m: string) => errors.push({ fallback: m }),
    warning: (m: string) => warnings.push({ fallback: m }),
    message: () => {},
  },
}));
vi.mock("@/lib/toast-error", () => ({
  toastError: (_e: unknown, fallback?: string) => {
    errors.push({ fallback });
    return {};
  },
  toastWarning: (
    _e: unknown,
    fallback?: string,
    ctx?: { nextStep?: string },
  ) => {
    warnings.push({ fallback, nextStep: ctx?.nextStep });
    return {};
  },
}));

// -- the eBay hooks ----------------------------------------------------------
// All five are network. Label buying is switched OFF so the dialog renders only
// the carrier + tracking form and the footer.
const shipMutate = vi.fn(() => Promise.resolve({ pushed_to_ebay: false }));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayShipOrder: () => ({ mutateAsync: shipMutate, isPending: false }),
  useEbayLogisticsCapability: () => ({ data: { labelPurchaseAvailable: false } }),
  useEbayShippingRates: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEbayBuyLabel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEbayReprintLabel: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { ShipOrderDialog } = await import("@/components/flipdesk/ship-order-dialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM = {
  id: "item-1",
  item_title: "Carhartt Detroit jacket",
  status: "sold",
} as never;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const closes: number[] = [];

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client: qc },
        h(
          MemoryRouter,
          null,
          h(ShipOrderDialog, {
            item: ITEM,
            onClose: () => closes.push(1),
          }),
        ),
      ),
    );
  });
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Radix renders the dialog in a portal, so search the whole document. */
function byText(text: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll("button"));
  return (all.find((b) => b.textContent?.trim() === text) as HTMLElement) ?? null;
}

async function markShipped(tracking = "9400100000000000000000") {
  const input = document.getElementById("ship-tracking") as HTMLInputElement;
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, tracking);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = byText("Mark shipped");
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
  });
  await settle();
}

beforeEach(() => {
  writes.length = 0;
  successes.length = 0;
  warnings.length = 0;
  errors.length = 0;
  closes.length = 0;
  salesUpdateError = null;
  statusUpdateError = null;
  shipMutate.mockClear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("ShipOrderDialog: the status write that moves it out of the ship queue", () => {
  it("does not say 'Marked shipped' when the item never left the queue", async () => {
    statusUpdateError = {
      code: "42501",
      message: "new row violates row-level security policy",
    };
    mount();
    await settle();
    await markShipped();

    // The write was really attempted, with the status the Shipped tab reads.
    expect(
      writes.some(
        (w) => w.table === "inventory_items" && w.patch.status === "shipped",
      ),
    ).toBe(true);
    // The lie this story is named after.
    expect(successes).toEqual([]);
    // What the seller gets instead: both halves named, and the recovery.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fallback).toContain("still in the ship queue");
    expect(warnings[0]!.nextStep).toContain("Mark shipped again");
    // And the dialog stays open, because pressing the button again IS the fix.
    expect(closes).toHaveLength(0);
  });

  it("says 'Marked shipped' and closes when the item really moved", async () => {
    mount();
    await settle();
    await markShipped();

    expect(
      writes.some(
        (w) => w.table === "inventory_items" && w.patch.status === "shipped",
      ),
    ).toBe(true);
    expect(successes).toEqual(["Marked shipped."]);
    expect(warnings).toEqual([]);
    expect(closes).toHaveLength(1);
  });

  it("still fails loudly, and does not reach the status write, when the sale write is refused", async () => {
    // The pre-existing checked write. Kept here so a future edit cannot "fix"
    // the new check by loosening this one.
    salesUpdateError = { message: "sales refused" };
    mount();
    await settle();
    await markShipped();

    expect(successes).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(
      writes.some((w) => w.table === "inventory_items"),
    ).toBe(false);
  });
});
