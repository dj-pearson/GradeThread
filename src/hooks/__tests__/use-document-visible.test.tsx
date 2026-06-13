import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDocumentVisible } from "@/hooks/use-document-visible";

// React 19 requires this flag for act() to flush effects in a test env.
// No @testing-library in this repo — render via createRoot like the app does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest = false;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  function Probe() {
    latest = useDocumentVisible();
    return null;
  }
  act(() => {
    root = createRoot(container!);
    root.render(h(Probe));
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  setVisibility("visible");
});

describe("useDocumentVisible", () => {
  it("starts visible when the document is visible", () => {
    setVisibility("visible");
    mount();
    expect(latest).toBe(true);
  });

  it("flips to false when the tab is hidden and back to true on return", () => {
    setVisibility("visible");
    mount();
    expect(latest).toBe(true);

    setVisibility("hidden");
    expect(latest).toBe(false);

    setVisibility("visible");
    expect(latest).toBe(true);
  });
});
