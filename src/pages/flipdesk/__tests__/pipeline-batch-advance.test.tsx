// The board's "Move to next status" batch action, rendered. One UPDATE per
// target stage comes back with `.select("id")`, and a card whose id is NOT in
// that answer was not moved: RLS hid it, or it was moved or deleted in another
// tab. Without the not-returned branch the whole chunk reads as moved whenever
// the call itself has no error, so the dialog would say "2 moved" for one write.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  returned: [] as Array<{ id: string }>,
  updateError: null as { message: string } | null,
  updates: [] as Array<{ patch: unknown; ids: string[]; from?: string }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "inventory_items") throw new Error(`unexpected table ${table}`);
      return {
        update: (patch: unknown) => ({
          in: (_col: string, ids: string[]) => ({
            // INV-8: every batch write carries the status it was read at.
            eq: (_c: string, from: string) => ({
              select: async () => {
                mocks.updates.push({ patch, ids, from });
                return mocks.updateError
                  ? { data: null, error: mocks.updateError }
                  : { data: mocks.returned, error: null };
              },
            }),
          }),
        }),
      };
    },
  },
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: "owner-1" } }),
}));
vi.mock("@/hooks/use-rewards", () => ({ useRewards: () => ({}) }));
vi.mock("@/hooks/use-items-full", () => ({
  useItemsList: () => ({
    data: mocks.items,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  itemsListQueryKey: (id: string | undefined) => ["items_full", "list", id],
}));
vi.mock("@/hooks/use-inventory-status-counts", () => ({
  useInventoryStatusCounts: () => ({ data: {} }),
}));
vi.mock("@/hooks/use-ebay", () => ({ useListingComplianceFlags: () => ({ data: [] }) }));
vi.mock("@/hooks/use-saved-views", () => ({ useSavedViews: () => ({ data: [] }) }));
vi.mock("@/hooks/use-grading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-grading")>()),
  useValidateGradingBulk: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSubmitGradingBulk: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/flipdesk/item-detail-dialog", () => ({ ItemDetailDialog: () => null }));
vi.mock("@/components/flipdesk/save-view-dialog", () => ({ SaveViewDialog: () => null }));
vi.mock("@/components/flipdesk/filter-builder", () => ({ FilterBuilder: () => null }));
vi.mock("@/components/flipdesk/inventory-view-switcher", () => ({
  InventoryViewSwitcher: () => null,
}));
vi.mock("@/components/help/help-link", () => ({ HelpLink: () => null }));

const { FlipdeskPipelinePage } = await import("@/pages/flipdesk/pipeline");
const { useInventorySelection } = await import("@/stores/inventory-selection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function row(id: string, title: string, status = "sourced") {
  return {
    id,
    item_title: title,
    status,
    brand: null,
    style: null,
    size: null,
    category: "tops",
    source_name: null,
    item_number: null,
    measurements: null,
    has_required_photos: false,
    grade_value: null,
    target_price: null,
    list_price: null,
    sale_price: null,
    purchase_price: null,
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <FlipdeskPipelinePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function moveSelectedToNext() {
  const button = Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Move to next status"),
  );
  expect(button, "the batch bar did not render").toBeTruthy();
  await act(async () => {
    button!.click();
  });
  await flush();
}

function resultsDialog(): HTMLElement {
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog, "the results dialog did not open").not.toBeNull();
  return dialog!;
}

function resultFor(title: string): string {
  const li = Array.from(resultsDialog().querySelectorAll("li")).find((l) =>
    l.textContent?.includes(title),
  );
  expect(li, `no result row for ${title}`).toBeTruthy();
  return li!.textContent ?? "";
}

beforeEach(() => {
  mocks.items = [row("a", "Wool coat"), row("b", "Denim jacket")];
  mocks.returned = [];
  mocks.updateError = null;
  mocks.updates = [];
  useInventorySelection.getState().setSelected(new Set(["a", "b"]));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  useInventorySelection.getState().clear();
});

describe("pipeline batch advance", () => {
  it("reports a card the UPDATE did not return as not moved", async () => {
    mocks.returned = [{ id: "a" }];
    await renderBoard();
    await moveSelectedToNext();

    // One write for the one target stage, carrying both ids.
    expect(mocks.updates).toEqual([
      { patch: { status: "cataloged" }, ids: ["a", "b"], from: "sourced" },
    ]);
    expect(resultsDialog().textContent).toContain("1 moved, 1 skipped.");
    expect(resultFor("Wool coat")).toMatch(/Cataloged/);
    expect(resultFor("Denim jacket")).toContain(
      "Not updated. Changed since you loaded the board.",
    );
  });

  it("reports every card moved when all ids come back", async () => {
    mocks.returned = [{ id: "a" }, { id: "b" }];
    await renderBoard();
    await moveSelectedToNext();
    expect(resultsDialog().textContent).toContain("2 moved, 0 skipped.");
    expect(useInventorySelection.getState().selected.size).toBe(0);
  });

  it("puts the error on every card of a chunk the UPDATE refused", async () => {
    mocks.updateError = { message: "permission denied for table inventory_items" };
    await renderBoard();
    await moveSelectedToNext();
    expect(resultsDialog().textContent).toContain("0 moved, 2 skipped.");
    expect(resultFor("Wool coat")).toContain("permission denied");
    expect(resultFor("Denim jacket")).toContain("permission denied");
  });

  it("splits a stage's writes by the status each card was read at (INV-8)", async () => {
    // acquired folds into the Sourced column, so both advance to cataloged,
    // but each write must carry its own from-status precondition.
    mocks.items = [row("a", "Wool coat", "sourced"), row("b", "Denim jacket", "acquired")];
    mocks.returned = [{ id: "a" }, { id: "b" }];
    await renderBoard();
    await moveSelectedToNext();
    const froms = mocks.updates.map((u) => [u.from, u.ids]);
    expect(froms).toContainEqual(["sourced", ["a"]]);
    expect(froms).toContainEqual(["acquired", ["b"]]);
  });
});
