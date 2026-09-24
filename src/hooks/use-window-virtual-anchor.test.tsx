// AL-12: the AutoLister grid and group list render only once they have
// content, so the node the virtual anchor measures does not exist at mount. A
// ref-object hook never measured it, and a 7-column grid showed 3 columns
// until a reload.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowVirtualAnchor, type WindowVirtualAnchor } from "./use-window-virtual-anchor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let seen: WindowVirtualAnchor | null = null;

function Probe({ show }: { show: boolean }) {
  const [ref, anchor] = useWindowVirtualAnchor<HTMLDivElement>();
  seen = anchor;
  return show ? h("div", { ref, "data-list": "" }) : h("p", null, "empty");
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const w = this.hasAttribute("data-list") ? 1120 : 0;
    return { top: 300, left: 0, width: w, height: 0, right: w, bottom: 300, x: 0, y: 300, toJSON: () => ({}) };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  seen = null;
});

describe("useWindowVirtualAnchor (AL-12)", () => {
  it("measures a list that mounts after the page did", () => {
    act(() => root.render(h(Probe, { show: false })));
    expect(seen?.width).toBe(0);

    // Photos dropped into an empty session: the list appears.
    act(() => root.render(h(Probe, { show: true })));
    expect(seen?.width).toBe(1120);
    expect(seen?.offsetTop).toBe(300);
  });

  it("measures a list present from the first render", () => {
    act(() => root.render(h(Probe, { show: true })));
    expect(seen?.width).toBe(1120);
  });
});
