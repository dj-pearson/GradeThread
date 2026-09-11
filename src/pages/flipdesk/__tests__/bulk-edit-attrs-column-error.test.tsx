import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement as h, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// US-3390. The bulk grid reads each draft's item row for the Brand, Size and
// Color placeholders and the cost behind the P&L column. US-3376 made that read
// THROW on a refusal instead of resolving as success with an empty map, so the
// query stopped caching a lie. The grid still destructured `= {}` though, so a
// refused read painted the same blank placeholders as an item that genuinely
// has no brand, no size and no color, and nothing on screen said otherwise.
//
// This file MOUNTS the page with a refused attrs read, because the assertion
// that matters is what the SELLER is told. Asserting that the hook throws is
// already covered one level down, and it is exactly the assertion this class of
// bug walks past.
//
// The refusal RESOLVES rather than rejects. That is the property the whole
// class lives on: supabase-js hands back `{ data: null, error }` on an RLS
// refusal or a 400, so a mock that rejects would test a different failure than
// the one that happens.

const TEST_USER = { id: "11111111-1111-4111-8111-111111111111" };

const DRAFTS = [
  {
    id: "dddddddd-0000-4000-8000-000000000001",
    inventory_item_id: "iiiiiiii-0000-4000-8000-000000000001",
    listing_title: "Levi's 501 denim jacket",
    listing_description: "A jacket.",
    listing_price: 48,
    ebay_condition: "USED_EXCELLENT",
    quantity: 1,
    best_offer_enabled: false,
    best_offer_auto_accept_cents: null,
    best_offer_auto_decline_cents: null,
    scheduled_publish_at: null,
    platform_category_id: "57988",
    item_specifics_override: {},
    item_specifics_sources: {},
    ai_generated_snapshot: null,
    price_range_low_cents: null,
    price_range_high_cents: null,
    shipping_policy_id: null,
    payment_policy_id: null,
    return_policy_id: null,
    listing_origin: null,
    title_variants: null,
  },
  {
    id: "dddddddd-0000-4000-8000-000000000002",
    inventory_item_id: "iiiiiiii-0000-4000-8000-000000000002",
    listing_title: "Carhartt duck chore coat",
    listing_description: "A coat.",
    listing_price: 72,
    ebay_condition: "USED_GOOD",
    quantity: 1,
    best_offer_enabled: false,
    best_offer_auto_accept_cents: null,
    best_offer_auto_decline_cents: null,
    scheduled_publish_at: null,
    platform_category_id: "57988",
    item_specifics_override: {},
    item_specifics_sources: {},
    ai_generated_snapshot: null,
    price_range_low_cents: null,
    price_range_high_cents: null,
    shipping_policy_id: null,
    payment_policy_id: null,
    return_policy_id: null,
    listing_origin: null,
    title_variants: null,
  },
];

const ITEMS = [
  {
    id: "iiiiiiii-0000-4000-8000-000000000001",
    title: "Levi's 501 denim jacket",
    brand: "Levi's",
    size: "L",
    color: "Blue",
    material: "Denim",
    style: "Trucker",
    item_category: "jacket",
    attributes: null,
    acquired_price: 12,
    garment_category: null,
    measurements: null,
  },
  {
    id: "iiiiiiii-0000-4000-8000-000000000002",
    title: "Carhartt duck chore coat",
    brand: "Carhartt",
    size: "XL",
    color: "Brown",
    material: "Duck canvas",
    style: "Chore",
    item_category: "jacket",
    attributes: null,
    acquired_price: 20,
    garment_category: null,
    measurements: null,
  },
];

/** How the next inventory_items read answers. Set per test. */
let itemsRefused = false;
/** Every inventory_items read the page has issued. */
let itemReads = 0;

function builder(result: () => { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  for (const k of [
    "select",
    "eq",
    "neq",
    "in",
    "is",
    "not",
    "gt",
    "gte",
    "lt",
    "lte",
    "like",
    "ilike",
    "order",
    "range",
    "limit",
    "filter",
    "contains",
    "overlaps",
    "returns",
    "abortSignal",
    "insert",
    "update",
    "upsert",
    "delete",
  ]) {
    b[k] = chain;
  }
  b["single"] = () => Promise.resolve({ data: null, error: null });
  b["maybeSingle"] = () => Promise.resolve({ data: null, error: null });
  // RESOLVES. A supabase builder does not reject on a refusal.
  b["then"] = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(result()).then(onFulfilled);
  return b;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "listings") {
        return builder(() => ({ data: DRAFTS, error: null }));
      }
      if (table === "inventory_items") {
        return builder(() => {
          itemReads += 1;
          return itemsRefused
            ? {
                data: null,
                error: {
                  message:
                    'permission denied for table "inventory_items"',
                  code: "42501",
                },
              }
            : { data: ITEMS, error: null };
        });
      }
      return builder(() => ({ data: [], error: null }));
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { user: TEST_USER } }, error: null }),
      getUser: () => Promise.resolve({ data: { user: TEST_USER }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
    },
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
      subscribe: () => ({}),
      unsubscribe: () => {},
    }),
    removeChannel: () => {},
  },
}));

vi.mock("@/hooks/use-ebay", () => ({
  useEbayPolicies: () => ({ data: undefined, isFetching: false }),
  useEbayCategoryAspects: () => ({ data: undefined, isFetching: false }),
  useEbayCategorySuggest: () => ({ data: undefined, isFetching: false }),
  useAiExtractAspects: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The grid body is virtualized (US-416) and a jsdom scroll container measures
// 0px, so the real virtualizer renders ZERO rows and every per-row assertion
// below would pass vacuously. Render the whole (two-row) window instead.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: index,
        start: index * 64,
        end: (index + 1) * 64,
        size: 64,
      })),
    getTotalSize: () => opts.count * 64,
    measureElement: () => {},
  }),
}));

vi.mock("@/lib/flipdesk-templates", () => ({
  TEMPLATES_QUERY_KEY: ["flipdesk_templates"],
  listTemplates: () => Promise.resolve([]),
}));

vi.mock("sonner", () => {
  const noop = () => {};
  return {
    toast: Object.assign(noop, {
      success: noop,
      error: noop,
      warning: noop,
      info: noop,
      message: noop,
      dismiss: noop,
    }),
    Toaster: () => null,
  };
});

vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: () =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  edgeAuthHeaders: () => Promise.resolve({}),
}));

import { useAuthStore } from "@/stores/auth-store";
import { FlipdeskAutolisterBulkEditPage } from "@/pages/flipdesk/autolister-bulk-edit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const router = createMemoryRouter([{ path: "*", element: node }], {
    initialEntries: ["/dashboard/flipdesk/autolister/bulk-edit?batch=batch-1"],
  });
  act(() => {
    root = createRoot(container!);
    root.render(
      h(QueryClientProvider, { client: qc }, h(RouterProvider, { router })),
    );
  });
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** The text of every alert the page is showing. */
function alerts(): string[] {
  return [...container!.querySelectorAll('[role="alert"]')].map((el) =>
    (el.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

/** Every placeholder the grid's inputs are currently showing. */
function placeholders(): string[] {
  return [...container!.querySelectorAll("input")].map(
    (el) => el.getAttribute("placeholder") ?? "",
  );
}

beforeEach(() => {
  itemsRefused = false;
  itemReads = 0;
  useAuthStore.setState({
    user: TEST_USER as never,
    session: { user: TEST_USER } as never,
    isLoading: false,
    activeWorkspaceOwnerId: TEST_USER.id,
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("US-3390: a refused item-attrs read is said out loud", () => {
  it("a good read fills the placeholders and shows no alert", async () => {
    mount(h(FlipdeskAutolisterBulkEditPage));
    await settle();

    // The guard against a vacuous pass: if the virtualizer rendered nothing,
    // there are no placeholders to find and the failing case below proves
    // nothing either.
    const good = placeholders();
    expect(good, "the grid rendered no rows at all").toContain("Levi's");
    expect(good).toContain("Carhartt");

    expect(
      alerts().join(" | "),
      "a successful read still warned about something",
    ).not.toMatch(/Couldn't load/i);
  });

  it("a refused read tells the seller the columns are blank because it failed", async () => {
    itemsRefused = true;
    mount(h(FlipdeskAutolisterBulkEditPage));
    await settle();

    // The drafts themselves loaded, so the grid is on screen and usable.
    expect(
      [...container!.querySelectorAll("input")].length,
      "the grid did not render, so this test cannot see the columns",
    ).toBeGreaterThan(0);

    // The bug: the Brand/Size/Color placeholders fall back to an em dash, which
    // is indistinguishable from an item that genuinely has none.
    const blank = placeholders();
    expect(blank, "the placeholders did not go blank on a refusal").not.toContain(
      "Levi's",
    );

    const text = alerts().join(" | ");
    expect(
      text,
      `the page said nothing about the refused read. Alerts: ${text || "(none)"}`,
    ).toContain("Couldn't load");
    expect(text).toContain("Brand");
    expect(text).toContain("Size");
    expect(text).toContain("Color");
    // The whole point: blank because the READ failed, not because the drafts
    // have nothing in them.
    expect(text).toMatch(/read failed/i);
    expect(text).toMatch(/not because the drafts are empty/i);
  });

  it("the seller can ask for it again, and it is one banner not a second copy", async () => {
    itemsRefused = true;
    mount(h(FlipdeskAutolisterBulkEditPage));
    await settle();

    const failing = alerts().filter((t) => t.includes("Couldn't load"));
    expect(
      failing.length,
      "the failed-read banner should appear exactly once",
    ).toBe(1);

    const before = itemReads;
    expect(before, "the attrs read never ran").toBeGreaterThan(0);

    const retry = [...container!.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").trim().startsWith("Try again"),
    );
    expect(retry, "the failed-read banner offered no retry").toBeTruthy();

    // The read recovers on the retry, and the grid fills in.
    itemsRefused = false;
    await act(async () => {
      retry!.click();
    });
    await settle();

    expect(itemReads, "clicking retry did not re-read").toBeGreaterThan(before);
    expect(
      alerts().join(" | "),
      "the banner stayed up after a successful retry",
    ).not.toContain("Couldn't load");
    expect(placeholders()).toContain("Levi's");
  });
});
