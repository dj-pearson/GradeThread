// US-3376 AC5, rank 5: the dropped READ that could skip the delist step.
//
// After a manual sale, RecordSaleDialog asks the server to end every other
// listing of the garment, then re-reads `listings` to see what is still live.
// That read dropped its error, so a refusal counted as zero live listings, and
// `showDelistStep` could come out false: the dialog closed on a success toast
// and a sold garment stayed for sale somewhere else. It bites exactly when the
// auto-end lied, which is the one case the step exists for.
//
// Driven through the real button, asserting what the seller sees: the delist
// step instead of a closed dialog.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const SOLD_LISTING = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_ID = "bbbbbbbb-0000-4000-8000-000000000002";

// -- supabase ----------------------------------------------------------------
// Two different `listings` selects run here and only ONE is under test:
//   .select("id, quantity").eq("id", <sold listing>).maybeSingle()  -> the close
//   .select("id, listing_status").eq("inventory_item_id", <item>)   -> the probe
// Keyed on the filter column so the probe can fail on its own.
let probeError: unknown = null;
let probeRows: { id: string; listing_status: string }[] = [];
const probeCalls: number[] = [];

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      insert: () => Promise.resolve({ data: null, error: null }),
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      select: () => ({
        eq: (col: string) => {
          if (table === "listings" && col === "inventory_item_id") {
            probeCalls.push(1);
            // Resolves with { error }. It does not reject - a try/catch around
            // it is not protection.
            return Promise.resolve({
              data: probeError ? null : probeRows,
              error: probeError,
            });
          }
          return {
            maybeSingle: () =>
              Promise.resolve({
                data: { id: SOLD_LISTING, quantity: 1 },
                error: null,
              }),
          };
        },
      }),
    }),
  },
}));

vi.mock("@/lib/status-writer", () => ({
  advanceItemStatus: () => Promise.resolve(),
}));

const LISTING_ROW = {
  id: SOLD_LISTING,
  platform: "ebay",
  listing_status: "active",
  listing_url: null,
  listing_title: "Carhartt Detroit jacket",
  listing_description: null,
  listing_price: 90,
  quantity: 1,
  platform_offer_id: null,
  platform_listing_id: null,
  batch_id: null,
  synced_to_ebay_at: null,
  platform_fields: null,
  publish_error: null,
  publish_failed_at: null,
  updated_at: null,
};

vi.mock("@/hooks/use-item-listings", () => ({
  useItemListings: () => ({ data: [LISTING_ROW] }),
  ITEM_LISTINGS_KEY: "item_listings",
  itemListingsKey: (id: string) => ["item_listings", id],
}));

// The auto-end reports total success and nothing pending. That is the whole
// point: every OTHER signal says "nothing left to do", so the probe is the only
// thing standing between the seller and a garment still for sale elsewhere.
vi.mock("@/hooks/use-pending-delists", () => ({
  useEndOtherListings: () => ({
    mutateAsync: () =>
      Promise.resolve({
        summary: { ended: 0, queued: 0, unresolved: 0, nothingLive: 0 },
        pending: [],
      }),
  }),
}));

vi.mock("@/components/flipdesk/delist-panel", () => ({
  ItemDelistPanel: () =>
    h("div", { "data-testid": "delist-panel" }, "Delist from other platforms"),
}));

const successes: string[] = [];
const warnings: { fallback?: string; nextStep?: string }[] = [];
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => successes.push(m),
    error: () => {},
    warning: () => {},
    message: () => {},
  },
}));
vi.mock("@/lib/toast-error", () => ({
  toastError: () => ({}),
  toastWarning: (
    _e: unknown,
    fallback?: string,
    ctx?: { nextStep?: string },
  ) => {
    warnings.push({ fallback, nextStep: ctx?.nextStep });
    return {};
  },
}));

const { RecordSaleDialog } = await import(
  "@/components/flipdesk/record-sale-dialog"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM = {
  id: ITEM_ID,
  item_title: "Carhartt Detroit jacket",
  status: "listed",
  list_price: 90,
  purchase_price: 20,
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
        h(RecordSaleDialog, { item: ITEM, onClose: () => closes.push(1) }),
      ),
    );
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function button(text: string): HTMLElement | null {
  return (
    (Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLElement) ?? null
  );
}

async function recordSale() {
  const save = button("Save sale") ?? button("Record sale") ?? button("Save");
  expect(save).toBeTruthy();
  await act(async () => {
    save!.click();
  });
  await settle();
}

beforeEach(() => {
  successes.length = 0;
  warnings.length = 0;
  closes.length = 0;
  probeCalls.length = 0;
  probeError = null;
  probeRows = [];
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("RecordSaleDialog: the live-listing probe behind the delist step", () => {
  it("shows the delist step when it could not find out what is still live", async () => {
    probeError = { code: "42501", message: "permission denied for table listings" };
    mount();
    await settle();
    await recordSale();

    // The probe really ran, so this is about its answer and not about a code
    // path that never executed.
    expect(probeCalls).toHaveLength(1);
    // The sale is still recorded - that part must not regress.
    expect(successes.some((m) => m.includes("Sale recorded"))).toBe(true);
    // What the seller sees: the delist step, not a closed dialog.
    expect(document.querySelector('[data-testid="delist-panel"]')).toBeTruthy();
    expect(closes).toHaveLength(0);
    // And they are told why they are looking at it.
    expect(warnings.some((w) => w.fallback?.includes("still listed elsewhere"))).toBe(true);
  });

  it("closes when the probe really says nothing is left live", async () => {
    probeRows = [{ id: SOLD_LISTING, listing_status: "sold" }];
    mount();
    await settle();
    await recordSale();

    expect(probeCalls).toHaveLength(1);
    expect(document.querySelector('[data-testid="delist-panel"]')).toBeNull();
    expect(closes).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("shows the delist step when the probe finds a listing still live", async () => {
    probeRows = [
      { id: SOLD_LISTING, listing_status: "sold" },
      { id: "cccccccc-0000-4000-8000-000000000003", listing_status: "active" },
    ];
    mount();
    await settle();
    await recordSale();

    expect(document.querySelector('[data-testid="delist-panel"]')).toBeTruthy();
    expect(closes).toHaveLength(0);
    // No warning: nothing failed, the probe simply found something.
    expect(warnings).toEqual([]);
  });
});
