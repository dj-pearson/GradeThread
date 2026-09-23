// INV-13: the Inventory shell owns the title and the mode switcher, and the
// table page mounts one list per breakpoint.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (state: unknown) => unknown) =>
    select({ user: { id: "seller" }, activeWorkspaceOwnerId: null }),
}));
vi.mock("../listings", () => ({ FlipdeskListingsPage: () => h("p", null, "Table view") }));
vi.mock("../grid", () => ({ FlipdeskGridPage: () => h("p", null, "Grid view") }));
vi.mock("../pipeline", () => ({ FlipdeskPipelinePage: () => h("p", null, "Kanban view") }));
vi.mock("../prep", () => ({ FlipdeskPrepPage: () => h("p", null, "Prep view") }));

import { FlipdeskInventoryPage } from "../inventory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(path: string) {
  const router = createMemoryRouter(
    [{ path: "/dashboard/flipdesk/inventory", element: h(FlipdeskInventoryPage) }],
    { initialEntries: [path] },
  );
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(h(QueryClientProvider, { client: queries }, h(RouterProvider, { router }))),
  );
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("the Inventory shell", () => {
  it.each(["", "?mode=grid", "?mode=kanban", "?mode=prep"])(
    "renders one Inventory heading and the switcher for %s",
    async (qs) => {
      await mount(`/dashboard/flipdesk/inventory${qs}`);
      expect(host.querySelectorAll("h1")).toHaveLength(1);
      expect(host.querySelector("h1")?.textContent).toBe("Inventory");
      expect(host.textContent).toContain("Find items by stage, then act on one or many.");
      expect(host.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
    },
  );

  it("no mode renders its own title or switcher any more", () => {
    for (const f of ["listings.tsx", "grid.tsx", "pipeline.tsx", "prep.tsx"]) {
      const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk", f), "utf8");
      expect(src, f).not.toMatch(/<h1\b/);
      expect(src, f).not.toContain("<InventoryViewSwitcher");
    }
  });
});

describe("the table page mounts one list per breakpoint", () => {
  it("chooses the table or the card list, never both", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/listings.tsx"), "utf8");
    const i = src.indexOf("{isDesktop ? (");
    expect(i).toBeGreaterThan(-1);
    const branch = src.slice(i);
    const table = branch.indexOf("<ListingsTable");
    const split = branch.indexOf(") : (");
    const cards = branch.indexOf("<ItemCardList");
    expect(table).toBeGreaterThan(-1);
    expect(table).toBeLessThan(split);
    expect(cards).toBeGreaterThan(split);
    expect(src.match(/<ItemCardList\b/g)).toHaveLength(1);
    expect(src.match(/<ListingsTable\b/g)).toHaveLength(1);
  });
});
