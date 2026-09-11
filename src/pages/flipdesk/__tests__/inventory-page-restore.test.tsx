import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement as h, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// US-3207, the behavioural half.
//
// src/test/inventory-page-memory.test.ts SCANS the source of listings.tsx and
// grid.tsx for the skip-first-run refs and the `if (!pageData) return;` gate. A
// scan pins the spelling of a guard and never its answer: gate on the wrong
// value, or keep the comment and drop the line, and it stays green. This file
// MOUNTS the real page with the first fetch still in flight and reads the URL
// back, which is the only way AC3 and AC4 can actually be observed.
//
// It is also what found the bug the story shipped with. `setSearchParams` does
// NOT queue - react-router says so in its own docs - so two calls in one tick
// both build on the params of the render they were made in, and the second
// overwrites the first. A `setPage(1)` beside another params write therefore
// UNDID that write: every tab click left `?tab=` naming the tab the seller had
// just left, and removing one filter chip of two left `?filter=` encoding both.

// -- mocks -------------------------------------------------------------------
// The page and the hooks under it all read one supabase client. Everything
// except the page RPC answers empty; the RPC is a promise this test resolves by
// hand, so "the query has not come back yet" is a state the test can hold.

const TEST_USER = { id: "11111111-1111-4111-8111-111111111111" };

let releasePage: ((value: unknown) => void) | null = null;
let pagePromise: Promise<{ data: unknown; error: null }> | null = null;
// The grid does not use the RPC: it reads items_full through the query builder,
// so it needs its own gate or its "first fetch still pending" case resolves
// instantly and tests nothing.
let releaseRows: ((rows: unknown[], count: number) => void) | null = null;
let rowsPromise: Promise<{ data: unknown[]; error: null; count: number }> | null = null;

function freshPromises() {
  pagePromise = new Promise((resolve) => {
    releasePage = (value: unknown) => resolve({ data: value, error: null });
  });
  rowsPromise = new Promise((resolve) => {
    releaseRows = (rows: unknown[], count: number) =>
      resolve({ data: rows, error: null, count });
  });
}

function emptyBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const k of [
    "select",
    "eq",
    "neq",
    "in",
    "is",
    "not",
    "or",
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
    builder[k] = chain;
  }
  builder["single"] = () => Promise.resolve({ data: null, error: null });
  builder["maybeSingle"] = () => Promise.resolve({ data: null, error: null });
  builder["then"] = (onFulfilled: (v: unknown) => unknown) => rowsPromise!.then(onFulfilled);
  return builder;
}

// Every flipdesk_listing_page call, in order, so a test can prove the page it
// is asserting about actually reached a request instead of quietly never
// fetching at all.
const pageCalls: { p_offset?: number; p_limit?: number }[] = [];

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => emptyBuilder(),
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === "flipdesk_listing_page") {
        pageCalls.push(args as { p_offset?: number; p_limit?: number });
        return pagePromise;
      }
      return Promise.resolve({ data: null, error: null });
    },
    // getSession MUST hand back the same signed-in user the store is primed
    // with. useAuth's one-time initAuth resolves it and writes the result into
    // the store, so a null session here signs the test user OUT partway through
    // the first test that mounts a page, and both queries are `enabled: !!user`.
    // Every later assertion would then be reading a page whose fetch never
    // started, which looks exactly like a gate that works.
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { user: TEST_USER } }, error: null }),
      getUser: () => Promise.resolve({ data: { user: TEST_USER }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      refreshSession: () =>
        Promise.resolve({ data: { session: { user: TEST_USER } }, error: null }),
    },
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
      subscribe: () => ({}),
      unsubscribe: () => {},
    }),
    removeChannel: () => {},
    storage: {
      from: () => ({ createSignedUrl: () => Promise.resolve({ data: null, error: null }) }),
    },
  },
}));

import { useAuthStore } from "@/stores/auth-store";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { FlipdeskListingsPage } from "@/pages/flipdesk/listings";
import { FlipdeskGridPage } from "@/pages/flipdesk/grid";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentSearch = "";

function UrlProbe() {
  currentSearch = useLocation().search;
  return null;
}

function mountAt(initial: string, node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  // A DATA router, not MemoryRouter: the grid uses useNavigationGuard, which
  // calls useBlocker, which throws outside one. The app runs on
  // createBrowserRouter, so this is the closer match anyway.
  const router = createMemoryRouter(
    [{ path: "*", element: h(ConfirmProvider, null, h(UrlProbe), node) }],
    { initialEntries: [initial] },
  );
  act(() => {
    root = createRoot(container!);
    root.render(h(QueryClientProvider, { client: qc }, h(RouterProvider, { router })));
  });
  return router;
}

/** Let effects, the router navigation and react-query all settle. */
async function settle() {
  // Microtasks alone are not enough: react-query notifies through its own
  // scheduler and React defers some work to a macrotask, so a settle() built
  // only from `await Promise.resolve()` made the grid clamp case pass or fail
  // depending on which other tests ran first. A timer turn per round fixes it.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function param(key: string): string | null {
  return new URLSearchParams(currentSearch).get(key);
}

function pageParam(): string | null {
  return param("page");
}

const ROW = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  user_id: "11111111-1111-4111-8111-111111111111",
  item_number: "SKU-1",
  item_title: "A jacket",
  brand: "Nike",
  status: "listed",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function resolvePage(total: number, rows: unknown[] = [ROW]) {
  releasePage!({ total, rows, soldAgg: null, buyerCounts: {} });
  return pagePromise;
}

function resolveRows(count: number) {
  releaseRows!([], count);
  return rowsPromise;
}

beforeEach(() => {
  freshPromises();
  pageCalls.length = 0;
  currentSearch = "";
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
  releasePage = null;
  pagePromise = null;
  releaseRows = null;
  rowsPromise = null;
});

describe("AC4: an inbound ?page= survives the render before the fetch lands", () => {
  it("keeps ?page=3 while the first fetch is still in flight", async () => {
    // The failure the story is named after. `totalRows` is `pageData?.total ??
    // 0`, so on the first render totalPages is 1. An unguarded clamp rewrites
    // ?page=3 to 1 right here, while the request for page 3 is still on the
    // wire, and the restore is destroyed before it can do anything. A test that
    // mounts with resolved data cannot see this.
    mountAt("/dashboard/flipdesk/inventory?tab=active&sort=oldest&page=3", h(FlipdeskListingsPage));
    await settle();
    expect(pageParam()).toBe("3");
    // And prove the query is genuinely in flight FOR PAGE 3 rather than never
    // having started - `enabled: !!user`, so a signed-out page keeps ?page=3
    // for a reason that has nothing to do with the gate under test.
    expect(pageCalls.length).toBeGreaterThan(0);
    expect(pageCalls[pageCalls.length - 1]?.p_offset).toBe(200);
    expect(pageCalls[pageCalls.length - 1]?.p_limit).toBe(100);
  });

  it("keeps ?page=3 once a result set big enough to hold it arrives", async () => {
    mountAt("/dashboard/flipdesk/inventory?tab=active&page=3", h(FlipdeskListingsPage));
    await act(async () => {
      await resolvePage(900);
    });
    await settle();
    expect(pageParam()).toBe("3");
  });

  it("clamps once the count proves the page does not exist", async () => {
    // The gate has to be a WAIT, not a disable. A genuinely out-of-range page
    // must come back into range the moment the total is known, or a stale
    // bookmark leaves the seller on an empty table under a pager that
    // contradicts it.
    mountAt("/dashboard/flipdesk/inventory?tab=active&page=9", h(FlipdeskListingsPage));
    await act(async () => {
      await resolvePage(40);
    });
    await settle();
    // 40 rows at the default 100 per page is one page, and page 1 writes no param.
    expect(pageParam()).toBe(null);
  });
});

describe("AC3: the reset effects skip their first run and only their first run", () => {
  it("mounting with a tab and a page in the URL keeps both", async () => {
    mountAt("/dashboard/flipdesk/inventory?tab=sold&page=4", h(FlipdeskListingsPage));
    await settle();
    expect(pageParam()).toBe("4");
    expect(param("tab")).toBe("sold");
  });

  it("a real tab change afterwards goes back to page 1 AND names the new tab", async () => {
    // The second half of that sentence is the regression this file found. The
    // tab write and a separate setPage(1) landed in the same tick, so the page
    // write - built from params captured before the tab was set - put `?tab=`
    // back to the tab the seller had just left. The screen showed Sold and the
    // URL said Active, which is exactly the state the round trip through an
    // item reads back.
    mountAt("/dashboard/flipdesk/inventory?tab=active&page=4&q=nike", h(FlipdeskListingsPage));
    await act(async () => {
      await resolvePage(900);
    });
    expect(pageParam()).toBe("4");

    const sold = Array.from(container!.querySelectorAll<HTMLElement>('button[role="tab"]')).find(
      (b) => /^sold/i.test(b.textContent ?? ""),
    );
    expect(sold, "a Sold tab trigger must exist or this test means nothing").toBeTruthy();
    await act(async () => {
      // Radix TabsTrigger selects on mousedown, not on a bare click().
      sold!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await settle();

    expect(param("tab")).toBe("sold");
    // Page 4 of Active is a different hundred rows than page 4 of Sold.
    expect(pageParam()).toBe(null);
    // And the change costs nothing else in the URL.
    expect(param("q")).toBe("nike");
  });

  it("a re-sort goes back to page 1", async () => {
    // Staying on page 6 of a list the seller just asked to see in a new order
    // shows them an arbitrary slice of it. Driven through `?sort=`, which is
    // what the sort menu writes.
    const router = mountAt(
      "/dashboard/flipdesk/inventory?tab=active&page=6",
      h(FlipdeskListingsPage),
    );
    await act(async () => {
      await resolvePage(900);
    });
    expect(pageParam()).toBe("6");
    await act(async () => {
      await router.navigate("/dashboard/flipdesk/inventory?tab=active&page=6&sort=most_views", {
        replace: true,
      });
    });
    await settle();
    expect(param("sort")).toBe("most_views");
    expect(pageParam()).toBe(null);
  });

  it("removing a filter chip resets the page AND leaves the new filter in the URL", async () => {
    // Same collision as the tab one, found the same way. The filter effect
    // wrote the one-rule encoding and the criteria effect's setPage(1) wrote
    // the two-rule one back over it, so the chips said one rule and the URL
    // said two - and the URL is what a teammate or a return trip reads.
    const enc = (q: unknown) => btoa(encodeURIComponent(JSON.stringify(q)));
    const ruleA = { id: "r1", field: "brand", op: "eq", value: "nike" };
    const ruleB = { id: "r2", field: "brand", op: "eq", value: "adidas" };
    const two = { combinator: "and", rules: [ruleA, ruleB] };
    const one = { combinator: "and", rules: [ruleB] };

    mountAt(
      `/dashboard/flipdesk/inventory?tab=active&page=4&filter=${encodeURIComponent(enc(two))}`,
      h(FlipdeskListingsPage),
    );
    await act(async () => {
      await resolvePage(900);
    });
    const chips = Array.from(
      container!.querySelectorAll<HTMLElement>('button[aria-label^="Remove filter"]'),
    );
    expect(chips.length, "two filter chips must render or this test means nothing").toBe(2);
    await act(async () => {
      chips[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await settle();

    expect(param("filter")).toBe(enc(one));
    expect(pageParam()).toBe(null);
  });
});

describe("AC7 as corrected: the grid pages the same way", () => {
  // The grid HAS a pager, which the story's original AC7 said it did not, and
  // it shares the URL with the table. It reads items_full through the query
  // builder rather than the RPC, so it gets its own gate above.
  it("keeps ?page=3 with its own first fetch still pending", async () => {
    mountAt("/dashboard/flipdesk/inventory?mode=grid&page=3", h(FlipdeskGridPage));
    await settle();
    expect(pageParam()).toBe("3");
  });

  it("keeps ?page=3 when the count is big enough to hold it", async () => {
    mountAt("/dashboard/flipdesk/inventory?mode=grid&page=3", h(FlipdeskGridPage));
    await act(async () => {
      await resolveRows(900);
    });
    await settle();
    expect(pageParam()).toBe("3");
  });

  it("clamps once the count proves the page does not exist", async () => {
    mountAt("/dashboard/flipdesk/inventory?mode=grid&page=9", h(FlipdeskGridPage));
    await act(async () => {
      await resolveRows(40);
    });
    await settle();
    // The grid's page size is a fixed 100, so 40 rows is one page.
    expect(pageParam()).toBe(null);
  });
});


describe("the pager actually pages (AC5, and the reason the rest of it mattered)", () => {
  function pagerButton(label: string): HTMLElement | undefined {
    return Array.from(container!.querySelectorAll<HTMLElement>("button")).find(
      (b) => (b.textContent ?? "").trim() === label,
    );
  }

  it("Next moves forward and Prev moves back, without stacking history", async () => {
    // This failed on main before the story was re-opened, and it failed
    // SILENTLY: the button was enabled, the click landed, and nothing moved.
    // react-router rebuilds setSearchParams on every URL change, so the setter
    // built on it was a new identity after each navigation - and the "reset to
    // page 1 when the criteria change" effect lists that setter in its deps.
    // Clicking Next navigated to ?page=2 and the effect immediately reset it.
    const router = mountAt("/dashboard/flipdesk/inventory?tab=active", h(FlipdeskListingsPage));
    await act(async () => {
      await resolvePage(900);
    });
    await settle();
    expect(pagerButton("Next"), "a Next button must render or this test means nothing").toBeTruthy();

    await act(async () => {
      pagerButton("Next")!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await settle();
    expect(pageParam()).toBe("2");

    await act(async () => {
      pagerButton("Next")!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await settle();
    expect(pageParam()).toBe("3");

    await act(async () => {
      pagerButton("Prev")!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await settle();
    expect(pageParam()).toBe("2");
    // Three clicks, still one history entry.
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("the request follows the page the seller is on", async () => {
    mountAt("/dashboard/flipdesk/inventory?tab=active", h(FlipdeskListingsPage));
    await act(async () => {
      await resolvePage(900);
    });
    await settle();
    freshPromises();
    await act(async () => {
      pagerButton("Next")!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await settle();
    // Not just the URL: the offset that goes to flipdesk_listing_page.
    expect(pageCalls[pageCalls.length - 1]?.p_offset).toBe(100);
  });
});
