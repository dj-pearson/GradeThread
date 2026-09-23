import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useSearchParams } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryViewKey, inventoryViewSearch, readInventoryView, writeInventoryView } from "../inventory-last-view";

vi.mock("@/stores/auth-store", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "seller" }, activeWorkspaceOwnerId: "shop" }) }));
vi.mock("../listings", () => ({ FlipdeskListingsPage: () => h("p", null, "Table view") }));
vi.mock("../pipeline", () => ({ FlipdeskPipelinePage: () => h("p", null, "Kanban view") }));
vi.mock("../prep", () => ({ FlipdeskPrepPage: () => h("p", null, "Prep view") }));
vi.mock("../grid", () => ({ FlipdeskGridPage: () => {
  const [, setParams] = useSearchParams();
  return h("button", { onClick: () => setParams({}) }, "Switch to table");
} }));
import { FlipdeskInventoryPage } from "../inventory";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { localStorage.clear(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function settle() { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function mount(path: string) {
  const router = createMemoryRouter([{ path: "/dashboard/flipdesk/inventory", element: h(FlipdeskInventoryPage) }, { path: "/away", element: h("p", null, "Away") }], { initialEntries: [path] });
  // US-3418 put SkuExhaustedBanner in the inventory shell, and it reads its row
  // through TanStack Query. The real app always has a provider above this; a
  // bare router here does not, and the banner threw before the route assertions
  // below ever ran. Retry off so a failed fetch settles instead of looping.
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(h(QueryClientProvider, { client: queries }, h(RouterProvider, { router }))));
  await settle();
  return router;
}

describe("remembered Inventory view", () => {
  it("remembers the Unlisted chip and the Sold window (INV-12)", () => {
    const params = new URLSearchParams("tab=sold&window=d30&show=ready&page=2&col=sale_price:desc");
    expect(inventoryViewSearch(params)).toBe("tab=sold&show=ready&window=d30");
    expect(inventoryViewKey("u", "o")).toContain(":v2:");
  });
  it("still reads a remembered view saved under the v1 key", () => {
    localStorage.setItem("flipdesk:inventory:last-view:v1:old:shop", "mode=kanban&tab=active");
    expect(readInventoryView(inventoryViewKey("old", "shop"))).toBe("mode=kanban&tab=active");
    localStorage.removeItem("flipdesk:inventory:last-view:v1:old:shop");
  });
  it("keeps view settings without replaying a search, page or action", () => {
    const params = new URLSearchParams("mode=grid&sort=newest&tab=active&size=50&q=private&page=8&view=old&delist=1");
    expect(inventoryViewSearch(params)).toBe("mode=grid&sort=newest&tab=active&size=50");
    writeInventoryView(inventoryViewKey("one", "shop"), params);
    expect(readInventoryView(inventoryViewKey("two", "shop"))).toBe("");
    expect(readInventoryView(inventoryViewKey("one", "other"))).toBe("");
  });
  it("restores the last sort when returning through a bare Inventory link", async () => {
    const router = await mount("/dashboard/flipdesk/inventory?sort=newest&tab=active");
    await act(async () => { await router.navigate("/away"); });
    await act(async () => { await router.navigate("/dashboard/flipdesk/inventory"); });
    await settle();
    expect(router.state.location.search).toBe("?sort=newest&tab=active");
    expect(host.textContent).toContain("Table view");
  });
  it("honors an explicit link instead of merging a previous grid/filter into it", async () => {
    writeInventoryView(inventoryViewKey("seller", "shop"), new URLSearchParams("mode=grid&sort=newest&filter=old"));
    const router = await mount("/dashboard/flipdesk/inventory?tab=sold");
    expect(router.state.location.search).toBe("?tab=sold");
    expect(host.textContent).toContain("Table view");
  });
  it("allows switching a restored grid back to the default Table", async () => {
    writeInventoryView(inventoryViewKey("seller", "shop"), new URLSearchParams("mode=grid"));
    const router = await mount("/dashboard/flipdesk/inventory");
    expect(router.state.location.search).toBe("?mode=grid");
    await act(async () => { host.querySelector("button")!.click(); });
    await settle();
    expect(router.state.location.search).toBe("");
    expect(host.textContent).toContain("Table view");
    expect(readInventoryView(inventoryViewKey("seller", "shop"))).toBe("");
  });
});
