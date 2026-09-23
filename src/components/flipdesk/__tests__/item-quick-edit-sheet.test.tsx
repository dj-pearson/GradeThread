// INV-9: the quick-edit panel stops on failed saves, never pushes a live price
// as a side effect of j/k, and asks before discarding edits.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemFullRow } from "@/types/database";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => toasts.push(m),
    error: (m: string) => toasts.push(m),
  },
}));

const { ItemQuickEditSheet } = await import("@/components/flipdesk/item-quick-edit-sheet");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, over: Partial<ItemFullRow> = {}) =>
  ({
    id,
    item_title: `Item ${id}`,
    status: "listed",
    list_price: 40,
    target_price: 45,
    purchase_price: 6,
    location_bin: "A3",
    notes: null,
    listing_id: `L-${id}`,
    listing_status: "draft",
    ...over,
  }) as ItemFullRow;

let host: HTMLDivElement;
let root: Root;
const onSelect = vi.fn();
const onClose = vi.fn();
const actions = {
  patchItemColumns: vi.fn(async () => true),
  updateItemStatus: vi.fn(async () => true),
  updateListingPrice: vi.fn(async () => true),
};

function render(item: ItemFullRow, items: ItemFullRow[]) {
  act(() => {
    root.render(
      <ItemQuickEditSheet
        item={item}
        items={items}
        onSelect={onSelect}
        onClose={onClose}
        actions={actions}
      />,
    );
  });
}

function input(id: string): HTMLInputElement {
  const el = document.getElementById(id) as HTMLInputElement | null;
  expect(el, id).not.toBeNull();
  return el!;
}

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string, target?: Element) {
  const el = target ?? document.querySelector('[role="dialog"]')!;
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll("button")).find(
    (x) => x.textContent?.trim() === label || x.getAttribute("aria-label") === label,
  );
  expect(b, label).toBeTruthy();
  return b as HTMLButtonElement;
}

beforeEach(() => {
  toasts.length = 0;
  onSelect.mockReset();
  onClose.mockReset();
  actions.patchItemColumns.mockReset().mockResolvedValue(true);
  actions.updateItemStatus.mockReset().mockResolvedValue(true);
  actions.updateListingPrice.mockReset().mockResolvedValue(true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("ItemQuickEditSheet", () => {
  it("stays on the item when the price push fails", async () => {
    actions.updateListingPrice.mockResolvedValue(false);
    const a = row("a");
    render(a, [a, row("b")]);
    type(input("quick-edit-list-price"), "38");
    await act(async () => {
      button("Next item").click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(actions.updateListingPrice).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not autosave a changed LIVE price on j", async () => {
    const a = row("a", { listing_status: "active" } as Partial<ItemFullRow>);
    render(a, [a, row("b")]);
    type(input("quick-edit-list-price"), "38");
    await act(async () => {
      button("Next item").click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(actions.patchItemColumns).not.toHaveBeenCalled();
    expect(actions.updateListingPrice).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(toasts.join(" ")).toContain("Press Save");
  });

  it("refuses a price below the floor", () => {
    const a = row("a", { floor_price: 30 } as Partial<ItemFullRow>);
    render(a, [a]);
    type(input("quick-edit-list-price"), "4.99");
    expect(document.body.textContent).toContain("below your floor");
    expect(button("Save").disabled).toBe(true);
  });

  it("asks before discarding edits on Escape", async () => {
    const a = row("a");
    render(a, [a]);
    type(input("quick-edit-bin"), "Z9");
    await press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Discard them?");
    await act(async () => {
      button("Discard").click();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes straight away on Escape with nothing changed", async () => {
    const a = row("a");
    render(a, [a]);
    await press("Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
