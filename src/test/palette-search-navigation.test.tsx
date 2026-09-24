// F4 + F5: what the Cmd+K palette does with a search result.
//
// F4. Item and deep hits went to /dashboard/flipdesk/items?focus=<id>, which
// redirects to Inventory, and nothing there reads `focus`: the seller landed on
// the whole unfiltered list. Listing and sale hits were dropped whenever their
// parent item's title also matched, and picking an action typed as "set"
// recorded "set" as a recent search.
//
// F5. The outage flags were never reset, so an old failure bannered searches
// that never ran, and the Items section read the list cache once per owner, so
// a palette mounted before the list loaded stayed empty.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Row = {
  result_type: string;
  result_id: string;
  inventory_item_id: string;
  title: string;
  snippet: string;
  rank: number;
};

let rpcRows: Row[] = [];
let rpcError: unknown = null;
let ownedIds: string[] = [];

function chain(table: string) {
  const ops: [string, unknown[]][] = [];
  const self: Record<string, unknown> = {};
  for (const k of ["select", "ilike", "order", "limit", "in", "eq", "abortSignal"]) {
    self[k] = (...a: unknown[]) => {
      ops.push([k, a]);
      return self;
    };
  }
  self["then"] = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
    let data: unknown[] = [];
    if (table === "items_full") {
      const ids = (ops.find(([k]) => k === "in")?.[1][1] ?? []) as string[];
      data = ids.filter((id) => ownedIds.includes(id)).map((id) => ({ id, user_id: "user-1" }));
    }
    return Promise.resolve({ data, error: null }).then(ok, bad);
  };
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => {
      const p = Promise.resolve({ data: rpcError ? null : rpcRows, error: rpcError });
      return Object.assign(p, { abortSignal: () => p });
    },
  },
}));

const recorded: unknown[][] = [];
vi.mock("@/lib/recent-searches", () => ({
  fetchRecentSearches: () => Promise.resolve([]),
  recordSearch: (...a: unknown[]) => {
    recorded.push(a);
    return Promise.resolve();
  },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "user-1" }, profile: { role: "user" }, activeWorkspaceOwnerId: null }),
}));
vi.mock("@/stores/recent-store", () => ({
  useRecentStore: (sel: (s: unknown) => unknown) => sel({ recentItemIds: [] }),
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ can: () => true }),
}));

const { CommandPalette, OPEN_COMMAND_PALETTE_EVENT } = await import(
  "@/components/flipdesk/command-palette"
);
const { itemsListQueryKey } = await import("@/hooks/use-items-full");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let qc: QueryClient;
let loc = "";

function Probe() {
  const l = useLocation();
  loc = `${l.pathname}${l.search}`;
  return null;
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client: qc },
        h(MemoryRouter, { initialEntries: ["/dashboard"] }, h(Probe), h(CommandPalette)),
      ),
    );
  });
}

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function openPalette() {
  await act(async () => {
    window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
  });
}

async function closePalette() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await act(async () => {
    const input = document.querySelector("input");
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

async function type(term: string) {
  const input = document.querySelector("input");
  expect(input, "the palette did not open").toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, term);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(300);
  await settle(20);
}

function options(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

async function pick(textPart: string) {
  const opt = options().find((o) => (o.textContent ?? "").includes(textPart));
  expect(opt, `no option containing ${textPart}; saw ${options().map((o) => o.textContent).join(" | ")}`).toBeTruthy();
  await act(async () => opt!.click());
}

function row(type: string, id: string, item: string, title: string): Row {
  return { result_type: type, result_id: id, inventory_item_id: item, title, snippet: "", rank: 1 };
}

beforeEach(() => {
  rpcRows = [];
  rpcError = null;
  ownedIds = [];
  recorded.length = 0;
  loc = "";
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("palette navigation (F4)", () => {
  it("a deep hit opens the item page itself", async () => {
    rpcRows = [row("item", "it-9", "it-9", "Carhartt chore coat")];
    ownedIds = ["it-9"];
    mount();
    await openPalette();
    await type("chore");
    await pick("Carhartt chore coat");
    expect(loc.split("?")[0]).toBe("/dashboard/flipdesk/items/it-9");
    expect(recorded.map((r) => r[0])).toEqual(["chore"]);
  });

  it("picking an action records no search", async () => {
    mount();
    await openPalette();
    await type("settings");
    await pick("Go to Settings");
    expect(recorded).toEqual([]);
  });

  it("a listing hit survives when its parent item also matched by title", async () => {
    rpcRows = [
      row("item", "it-1", "it-1", "Levi's 501"),
      row("listing", "ls-1", "it-1", "Levi's 501 listing"),
    ];
    ownedIds = ["it-1"];
    mount();
    qc.setQueryData(itemsListQueryKey("user-1"), [
      { id: "it-1", item_title: "Levi's 501", brand: "Levi's", item_number: "J1", style: null, status: "cataloged", target_price: null },
    ]);
    await openPalette();
    await type("levi");
    const labels = options().map((o) => o.textContent ?? "");
    expect(labels.some((t) => t.includes("Levi's 501 listing"))).toBe(true);
    // The item hit itself is not shown twice.
    expect(labels.filter((t) => t.includes("Levi's 501") && t.includes("Item"))).toHaveLength(0);
  });

  it("offers the full Search page for the term", async () => {
    rpcRows = [row("item", "it-3", "it-3", "Denim jacket, blanket lined")];
    ownedIds = ["it-3"];
    mount();
    await openPalette();
    await type("denim jacket");
    await pick('See all results for "denim jacket"');
    expect(loc).toBe("/dashboard/flipdesk/search?q=denim%20jacket");
  });
});

describe("palette state does not go stale (F5)", () => {
  it("an old outage does not banner a search that never ran", async () => {
    rpcError = { code: "57014", message: "timeout" };
    mount();
    await openPalette();
    await type("carhartt");
    expect(document.body.textContent).toContain("unavailable");
    rpcError = null;
    await closePalette();
    await openPalette();
    await type("c");
    expect(document.body.textContent).not.toContain("unavailable");
  });

  it("items cached after mount show up the next time it opens", async () => {
    mount();
    qc.setQueryData(itemsListQueryKey("user-1"), [
      { id: "it-5", item_title: "Pendleton board shirt", brand: "Pendleton", item_number: "K7", style: null, status: "cataloged", target_price: 40 },
    ]);
    await openPalette();
    await type("pendleton");
    expect(options().some((o) => (o.textContent ?? "").includes("Pendleton board shirt"))).toBe(true);
  });
});
