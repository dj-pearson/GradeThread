// INV-8: Prep keeps what the seller typed across a refetch, and a failed read
// is shown as an error rather than as an empty queue.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: { data: [] as unknown[], isLoading: false, isError: false, isFetching: false, refetch: () => {} },
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({}) } }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: "u1" } }),
}));
vi.mock("@/hooks/use-items-full", () => ({
  useItemsList: () => mocks.list,
  useItemFull: () => ({ data: null }),
}));
vi.mock("@/hooks/use-ebay", () => ({ useGradeBandedPrice: () => ({ data: null }) }));
vi.mock("@/components/flipdesk/photo-uploader", () => ({ PhotoUploader: () => null }));
vi.mock("@/components/flipdesk/measurement-form", () => ({ MeasurementForm: () => null }));
vi.mock("@/components/flipdesk/sold-comp-recommendation", () => ({
  SoldCompRecommendation: () => null,
}));
vi.mock("@/components/flipdesk/inventory-view-switcher", () => ({
  InventoryViewSwitcher: () => null,
}));

const { FlipdeskPrepPage } = await import("@/pages/flipdesk/prep");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const client = new QueryClient();

function item(over: Record<string, unknown> = {}) {
  return {
    id: "i1",
    item_title: "Wool coat",
    status: "cataloged",
    category: "outerwear",
    measurements: null,
    target_price: 40,
    size: "M",
    has_required_photos: false,
    listing_id: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function render() {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <FlipdeskPrepPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

function priceInput(): HTMLInputElement {
  const inputs = Array.from(host.querySelectorAll<HTMLInputElement>("input"));
  const hit = inputs.find((i) => i.value === "40" || i.id.toLowerCase().includes("price"));
  expect(hit, "target price input").toBeTruthy();
  return hit!;
}

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.list = { data: [item()], isLoading: false, isError: false, isFetching: false, refetch: () => {} };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Prep", () => {
  it("keeps a typed price when the same item comes back as a new object", () => {
    render();
    type(priceInput(), "55");
    expect(priceInput().value).toBe("55");
    // An items_full invalidation (e.g. a photo upload) returns a fresh object
    // for the same item.
    mocks.list = { ...mocks.list, data: [item({ has_required_photos: true })] };
    render();
    expect(priceInput().value).toBe("55");
  });

  it("shows an error, not 'Prep queue is clear', when the read fails", () => {
    mocks.list = { data: [], isLoading: false, isError: true, isFetching: false, refetch: () => {} };
    render();
    expect(host.textContent).toContain("Couldn't load your prep queue");
    expect(host.textContent).not.toContain("Prep queue is clear");
  });

  it("a failed BACKGROUND refetch keeps the item and what was typed", () => {
    render();
    type(priceInput(), "55");
    // TanStack keeps the cached rows and flips isError when a refetch fails.
    mocks.list = { ...mocks.list, isError: true };
    render();
    expect(host.textContent).not.toContain("Couldn't load your prep queue");
    expect(priceInput().value).toBe("55");
  });
});
