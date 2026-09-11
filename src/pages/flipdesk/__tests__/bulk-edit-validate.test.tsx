import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement as h, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// US-3375. The bulk editor asked the edge whether a draft could publish and
// never looked at the status line. edgeFetch resolves a 500 like any other
// response, the error body carries no `blockers` array, so `blockers` became
// [], the row counted as CLEAN, and setRows wrote that empty array over the
// blockers a previous good run had found.
//
// This file MOUNTS the real page and clicks the real Validate button, because
// the assertion that matters is what the seller is told and what the row still
// remembers. A test that asserted `res.ok` is read would be the same kind of
// check the bug walked past.

// -- mocks -------------------------------------------------------------------

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
    item_specifics_override: {
      Department: ["Men"],
      Brand: ["Levi's"],
      Size: ["L"],
      Color: ["Blue"],
    },
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
    item_specifics_override: {
      Department: ["Men"],
      Brand: ["Carhartt"],
      Size: ["XL"],
      Color: ["Brown"],
    },
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

function builder(rows: unknown[]) {
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
  b["then"] = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(onFulfilled);
  return b;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => builder(table === "listings" ? DRAFTS : []),
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

// The eBay hooks all fetch. None of them is under test and every one of them
// would answer from the same edgeFetch stub, so they are stubbed whole and the
// stub stays a single-purpose recorder of /listings/validate calls.
vi.mock("@/hooks/use-ebay", () => ({
  useEbayPolicies: () => ({ data: undefined, isFetching: false }),
  useEbayCategoryAspects: () => ({ data: undefined, isFetching: false }),
  useEbayCategorySuggest: () => ({ data: undefined, isFetching: false }),
  useAiExtractAspects: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The grid body is virtualized (US-416) and a jsdom scroll container measures
// 0px, so the real virtualizer renders zero rows and every per-row assertion
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

type ToastCall = { level: string; message: string };
const toasts: ToastCall[] = [];
function record(level: string) {
  return (message: unknown) => {
    toasts.push({ level, message: String(message) });
  };
}
vi.mock("sonner", () => ({
  toast: Object.assign(record("default"), {
    success: record("success"),
    error: record("error"),
    warning: record("warning"),
    info: record("info"),
    message: record("message"),
    dismiss: () => {},
  }),
  Toaster: () => null,
}));

/** What the next /listings/validate call answers. Set per test. */
let validateReply: () => Response = () =>
  new Response(JSON.stringify({ ok: true, blockers: [] }), { status: 200 });
const validateCalls: string[] = [];

vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (path: string, opts?: { json?: { inventory_item_id?: string } }) => {
    if (path.includes("/listings/validate")) {
      validateCalls.push(opts?.json?.inventory_item_id ?? "");
      return Promise.resolve(validateReply());
    }
    return Promise.resolve(
      new Response(JSON.stringify({}), { status: 200 }),
    );
  },
  edgeAuthHeaders: () => Promise.resolve({}),
}));

import { useAuthStore } from "@/stores/auth-store";
import { FlipdeskAutolisterBulkEditPage } from "@/pages/flipdesk/autolister-bulk-edit";
import {
  applyValidation,
  validateOneRow,
  validationSummary,
} from "@/pages/flipdesk/autolister/validate-blockers";

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
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Every issue tooltip the grid is currently showing. */
function issueTooltips(): string[] {
  return [...container!.querySelectorAll("span[title]")].map(
    (el) => el.getAttribute("title") ?? "",
  );
}

async function clickValidate() {
  const btn = [...container!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith("Validate"),
  );
  expect(btn, "the Validate button is not on the page").toBeTruthy();
  await act(async () => {
    btn!.click();
  });
  await settle();
}

function lastToast(): ToastCall {
  const t = toasts[toasts.length - 1];
  expect(t, "the run produced no toast at all").toBeTruthy();
  return t!;
}

beforeEach(() => {
  toasts.length = 0;
  validateCalls.length = 0;
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

describe("US-3375: a validation that did not complete is its own answer", () => {
  it("a non-2xx row is not counted clean and does not erase the blockers a good run found", async () => {
    mount(h(FlipdeskAutolisterBulkEditPage));
    await settle();

    // Run 1: the endpoint answers, and both drafts are genuinely blocked.
    validateReply = () =>
      new Response(
        JSON.stringify({
          ok: false,
          blockers: ["Missing required aspect: Sleeve Length"],
        }),
        { status: 200 },
      );
    await clickValidate();

    expect(validateCalls.length, "both rows were asked about").toBe(2);
    expect(lastToast().message).toContain("0 clean");
    expect(lastToast().message).toContain("2 blocked");
    expect(
      issueTooltips().filter((t) => t.includes("Sleeve Length")).length,
      "both rows show the blocker after the good run",
    ).toBe(2);

    // Run 2: the endpoint is down. The seller learns nothing new, and must
    // not be told the drafts are fine.
    validateCalls.length = 0;
    validateReply = () =>
      new Response(JSON.stringify({ error: "internal error" }), { status: 500 });
    await clickValidate();

    expect(validateCalls.length).toBe(2);

    // AC3 first, because it is the one that matters most. The blockers from run
    // 1 are still there: destroying the evidence is worse than not refreshing
    // it.
    expect(
      issueTooltips().filter((t) => t.includes("Sleeve Length")).length,
      "the failed run erased the blockers the good run found",
    ).toBe(2);

    const after = lastToast();
    expect(
      after.message,
      `a failed run reported "${after.message}"`,
    ).not.toContain("2 clean");
    expect(after.message.toLowerCase()).toMatch(
      /could not|couldn't|unchecked|unknown/,
    );
    expect(after.level, "a failed run is not a success toast").not.toBe(
      "success",
    );
  });

  it("a 200 that does not carry a blockers array is also 'could not tell'", async () => {
    mount(h(FlipdeskAutolisterBulkEditPage));
    await settle();

    validateReply = () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });
    await clickValidate();

    const t = lastToast();
    expect(t.message, `reported "${t.message}"`).not.toContain("2 clean");
    expect(t.level).not.toBe("success");
  });

  it("a clean run still reads as clean", async () => {
    mount(h(FlipdeskAutolisterBulkEditPage));
    await settle();

    validateReply = () =>
      new Response(JSON.stringify({ ok: true, blockers: [] }), { status: 200 });
    await clickValidate();

    expect(lastToast().message).toContain("2 clean");
    expect(lastToast().level).toBe("success");
  });
});

// The same rules one level down, where the branches are cheap to reach. The
// mounted tests above are what prove the page uses them.
describe("US-3375: validate-blockers", () => {
  const row = { id: "r1", itemId: "i1" };

  function reply(status: number, body: unknown) {
    return () =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  it("a 429 is unchecked, not clean", async () => {
    const v = await validateOneRow(
      reply(429, { error: "Too many requests" }),
      row,
    );
    expect(v.outcome).toBe("unchecked");
    expect(v.blockers).toBeNull();
    expect(v.reason).toContain("429");
  });

  it("a 403 with no error string still says the status", async () => {
    const v = await validateOneRow(reply(403, {}), row);
    expect(v.outcome).toBe("unchecked");
    expect(v.reason).toBe("the server answered 403");
  });

  // The status line is the guard, on its own. A body-shape check alone passes
  // this case, and a body-shape check alone is what the bug was.
  it("a 500 that still carries a blockers array is unchecked", async () => {
    const v = await validateOneRow(reply(500, { ok: true, blockers: [] }), row);
    expect(v.outcome).toBe("unchecked");
    expect(v.blockers).toBeNull();
  });

  it("a transport failure is unchecked", async () => {
    const v = await validateOneRow(
      () => Promise.reject(new Error("Failed to fetch")),
      row,
    );
    expect(v.outcome).toBe("unchecked");
    expect(v.reason).toBe("Failed to fetch");
  });

  it("a 200 carrying blockers is blocked, and an empty list is clean", async () => {
    const blocked = await validateOneRow(
      reply(200, { ok: false, blockers: ["No shipping policy"] }),
      row,
    );
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.blockers).toEqual(["No shipping policy"]);

    const clean = await validateOneRow(
      reply(200, { ok: true, blockers: [] }),
      row,
    );
    expect(clean.outcome).toBe("clean");
    expect(clean.blockers).toEqual([]);
  });

  it("an unchecked result leaves the blockers it cannot refresh", () => {
    const rows = [
      {
        id: "r1",
        validationBlockers: ["No shipping policy"],
        validationUnchecked: null,
      },
    ];
    const next = applyValidation(rows, [
      { id: "r1", outcome: "unchecked", blockers: null, reason: "the server answered 500" },
    ]);
    expect(next[0]!.validationBlockers).toEqual(["No shipping policy"]);
    expect(next[0]!.validationUnchecked).toBe("the server answered 500");
  });

  it("a completed result replaces the blockers and clears the note", () => {
    const rows = [
      {
        id: "r1",
        validationBlockers: ["No shipping policy"],
        validationUnchecked: "the server answered 500",
      },
    ];
    const next = applyValidation(rows, [
      { id: "r1", outcome: "clean", blockers: [], reason: null },
    ]);
    expect(next[0]!.validationBlockers).toEqual([]);
    expect(next[0]!.validationUnchecked).toBeNull();
  });

  it("a run with anything unchecked is a warning, and says so", () => {
    expect(validationSummary(3, { clean: 2, blocked: 0, unchecked: 1 })).toEqual({
      level: "warning",
      message: "Validated 3: 2 clean, 0 blocked, 1 could not be checked.",
    });
    expect(validationSummary(2, { clean: 1, blocked: 1, unchecked: 0 })).toEqual({
      level: "success",
      message: "Validated 2: 1 clean, 1 blocked.",
    });
  });
});
