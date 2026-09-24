// The FlipDesk Search page, rendered. These replaced source-regex guards
// (search-outage-not-empty.test.ts kept one file-agnostic rule) because the
// failures they were about are timing failures: a stale row opened by Enter,
// a "No matches" frame before the first answer, a URL the page ignored.
//
// THE RPC MOCK RESOLVES AND NEVER REJECTS. supabase-js returns
// { data: null, error } on a Postgres error, so that is what a failure is here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Row = {
  result_type: string;
  result_id: string;
  inventory_item_id: string;
  title: string;
  snippet: string;
  rank: number;
};
type RpcArgs = { p_query: string; p_scope: string; p_limit: number };

let rpcImpl: (args: RpcArgs) => Promise<{ data: Row[] | null; error: unknown }>;
const rpcCalls: RpcArgs[] = [];
let itemRows: Record<string, unknown>[] = [];
let exactRows: Record<string, unknown>[] = [];

function chain(table: string) {
  const ops: [string, unknown[]][] = [];
  const self: Record<string, unknown> = {};
  for (const k of ["select", "in", "eq", "order", "limit", "or", "abortSignal", "delete"]) {
    self[k] = (...a: unknown[]) => {
      ops.push([k, a]);
      return self;
    };
  }
  self["then"] = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
    let data: unknown[] = [];
    if (table === "items_full") {
      const inOp = ops.find(([k]) => k === "in");
      const owner = ops.find(([k, a]) => k === "eq" && a[0] === "user_id")?.[1][1];
      if (inOp) {
        const ids = inOp[1][1] as string[];
        data = itemRows.filter((r) => ids.includes(r.id as string) && r.user_id === owner);
      } else if (ops.some(([k]) => k === "or")) {
        data = exactRows.filter((r) => r.user_id === owner);
      }
    }
    return Promise.resolve({ data, error: null }).then(ok, bad);
  };
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (_fn: string, args: RpcArgs) => {
      rpcCalls.push(args);
      const p = rpcImpl(args);
      return Object.assign(p, { abortSignal: () => p });
    },
  },
}));

const recorded: unknown[][] = [];
let recentRows: { query: string; scope: string; resultCount: number | null; updatedAt: string }[] = [];
vi.mock("@/lib/recent-searches", () => ({
  fetchRecentSearches: () => Promise.resolve(recentRows),
  recordSearch: (...a: unknown[]) => {
    recorded.push(a);
    return Promise.resolve();
  },
  removeRecentSearch: () => Promise.resolve(),
  clearRecentSearches: () => Promise.resolve(),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "owner-1" }, activeWorkspaceOwnerId: null }),
}));

const { FlipdeskSearchPage } = await import("@/pages/flipdesk/search");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let loc = "";
let nav: NavigateFunction | null = null;

function Probe() {
  const l = useLocation();
  nav = useNavigate();
  loc = `${l.pathname}${l.search}`;
  return null;
}

function mount(initial = "/dashboard/flipdesk/search") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client: qc },
        h(
          MemoryRouter,
          { initialEntries: [initial] },
          h(Probe),
          h(
            Routes,
            null,
            h(Route, { path: "/dashboard/flipdesk/search", element: h(FlipdeskSearchPage) }),
            h(Route, { path: "/dashboard/flipdesk/items/:id", element: h("p", null, "ITEM PAGE") }),
          ),
        ),
      ),
    );
  });
}

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function field(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('input[aria-label^="Search"]');
  expect(el, "search field not rendered").toBeTruthy();
  return el!;
}

async function type(term: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field(), term);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** Poll inside act until `cond` holds, or fail with what was on screen. */
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out; page said: ${text().slice(0, 400)}`);
    await settle(10);
  }
}

function text(): string {
  return document.body.textContent ?? "";
}

function row(id: string, type = "item", item = id, title = `Title ${id}`): Row {
  return { result_type: type, result_id: id, inventory_item_id: item, title, snippet: "", rank: 1 };
}

function item(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    user_id: "owner-1",
    item_title: `Title ${id}`,
    item_number: null,
    location_bin: null,
    status: "cataloged",
    ...extra,
  };
}

beforeEach(() => {
  rpcCalls.length = 0;
  recorded.length = 0;
  recentRows = [];
  exactRows = [];
  itemRows = [item("nike-1"), item("levis-1"), item("levis-2")];
  rpcImpl = (a) =>
    Promise.resolve({
      data: a.p_query.startsWith("ni")
        ? [row("nike-1")]
        : a.p_query.startsWith("lev")
          ? [row("levis-1"), row("levis-2")]
          : [],
      error: null,
    });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("a failed search says it failed (US-2517, S1)", () => {
  it("shows ErrorState with a retry and never 'No matches'", async () => {
    rpcImpl = () =>
      Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement" } });
    mount("/dashboard/flipdesk/search?q=nike");
    await settle(50);
    expect(text()).toContain("Search is unavailable");
    expect(text()).not.toContain("No matches");
    expect(text()).not.toMatch(/Nothing matched/);
    const retry = [...document.querySelectorAll("button")].find((b) =>
      /try again/i.test(b.textContent ?? ""),
    );
    expect(retry, "no retry button").toBeTruthy();

    // And the retry really asks again.
    rpcImpl = () => Promise.resolve({ data: [row("nike-1")], error: null });
    await act(async () => retry!.click());
    await settle(50);
    expect(text()).toContain("Title nike-1");
  });
});

describe("the shared hook caches (S1)", () => {
  it("typing the same term twice within 30s makes one RPC call", async () => {
    mount();
    await type("nike");
    await until(() => text().includes("Title nike-1"));
    await type("");
    await settle(300);
    await type("nike");
    await until(() => text().includes("Title nike-1"));
    await settle(300);
    expect(rpcCalls.filter((c) => c.p_query === "nike")).toHaveLength(1);
  });
});

describe("loading is not empty (F2)", () => {
  it("a pending search shows a status region, never 'No matches' or '0 results'", async () => {
    let release: () => void = () => {};
    rpcImpl = () =>
      new Promise((r) => {
        release = () => r({ data: [], error: null });
      });
    mount("/dashboard/flipdesk/search?q=nike");
    await settle(0);
    expect(text()).not.toContain("No matches");
    expect(text()).not.toContain("0 results");
    expect(document.querySelector('[role="status"]')).toBeTruthy();
    await settle(300);
    expect(text()).not.toContain("No matches");
    expect(text()).not.toContain("0 results");
    await act(async () => release());
    await settle(10);
    expect(text()).toMatch(/Nothing matched/);
  });
});

describe("Enter never opens a row from an older query (F1)", () => {
  it("a scanner that types and sends Enter inside the debounce opens the NEW term's hit", async () => {
    mount();
    // An older query is on screen.
    await type("nike");
    await until(() => text().includes("Title nike-1"));
    // Wedge-speed: the new term and Enter, with no debounce wait between.
    rpcImpl = (a) =>
      new Promise((r) =>
        setTimeout(
          () =>
            r({
              data: a.p_query === "levis" ? [row("levis-2"), row("levis-1")] : [],
              error: null,
            }),
          40,
        ),
      );
    await type("levis");
    await press("Enter");
    await settle(100);
    expect(loc).toBe("/dashboard/flipdesk/items/levis-2");
    expect(recorded[recorded.length - 1]?.[0]).toBe("levis");
  });

  it("Enter on a settled list opens the row under the cursor", async () => {
    mount();
    await type("levis");
    await until(() => text().includes("Title levis-2") && !!document.querySelector('[aria-selected="true"]'));
    await settle(20);
    await press("ArrowDown");
    await press("Enter");
    await settle(10);
    expect(loc).toBe("/dashboard/flipdesk/items/levis-2");
  });
});

describe("the URL is the source of truth (F3)", () => {
  it("follows an outside navigation to a bare /search and to a new q/scope", async () => {
    mount("/dashboard/flipdesk/search?q=nike");
    await settle(300);
    expect(field().value).toBe("nike");

    await act(async () => nav!("/dashboard/flipdesk/search"));
    await settle(10);
    expect(field().value).toBe("");

    await act(async () => nav!("/dashboard/flipdesk/search?q=levis&scope=sales"));
    await settle(10);
    expect(field().value).toBe("levis");
    const sales = [...document.querySelectorAll('[role="tab"]')].find(
      (t) => t.textContent === "Sales",
    );
    expect(sales?.getAttribute("data-state")).toBe("active");
  });

  it("keeps params it does not own when it writes q", async () => {
    mount("/dashboard/flipdesk/search?from=sidebar");
    await type("nike");
    await until(() => loc.includes("q=nike"));
    expect(loc).toContain("from=sidebar");
    expect(loc).toContain("q=nike");
  });
});
