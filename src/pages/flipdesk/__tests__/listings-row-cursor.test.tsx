// INV-15: the inventory table's keyboard row cursor.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRowCursor, type RowCursorHandlers } from "@/pages/flipdesk/listings-row-cursor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ids = ["a", "b", "c", "d"];
let cursor: number | null = null;
const h: RowCursorHandlers & { toggle: ReturnType<typeof vi.fn>; selectRange: ReturnType<typeof vi.fn>; quickEdit: ReturnType<typeof vi.fn> } = {
  count: ids.length,
  idAt: (i) => ids[i],
  toggle: vi.fn(),
  selectRange: vi.fn(),
  quickEdit: vi.fn(),
  openFull: vi.fn(),
  scrollTo: vi.fn(),
};

function Harness() {
  cursor = useRowCursor(h).cursor;
  return null;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  cursor = null;
  h.toggle.mockReset();
  h.selectRange.mockReset();
  h.quickEdit.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

function key(k: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
}

describe("useRowCursor", () => {
  it("j and k move the cursor and stop at the ends", () => {
    key("j");
    expect(cursor).toBe(0);
    key("j");
    key("j");
    expect(cursor).toBe(2);
    key("k");
    expect(cursor).toBe(1);
    key("k");
    key("k");
    expect(cursor).toBe(0);
    for (let i = 0; i < 6; i++) key("j");
    expect(cursor).toBe(3);
  });

  it("x toggles the cursor row and Shift+x selects the range", () => {
    key("j");
    key("x");
    expect(h.toggle).toHaveBeenCalledWith("a");
    key("j");
    key("j");
    key("X", { shiftKey: true });
    expect(h.selectRange).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("Enter opens quick edit on the cursor row, Esc drops the cursor", () => {
    key("j");
    key("j");
    key("Enter");
    expect(h.quickEdit).toHaveBeenCalledWith(1);
    key("Escape");
    expect(cursor).toBeNull();
  });

  it("does nothing while a dialog is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    key("j");
    key("x");
    expect(cursor).toBeNull();
    expect(h.toggle).not.toHaveBeenCalled();
  });

  it("does nothing while typing in a field", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    });
    expect(cursor).toBeNull();
  });
});
