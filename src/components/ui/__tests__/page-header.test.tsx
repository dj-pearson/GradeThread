import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Package } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

// React 19 requires this flag for act() to flush effects in a test env.
// No @testing-library in this repo — render via createRoot like the app does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("PageHeader", () => {
  it("renders the title as the single h1 with a subtitle", () => {
    render(h(PageHeader, { title: "Dashboard", subtitle: "Welcome back." }));
    const headings = container!.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe("Dashboard");
    expect(container!.textContent).toContain("Welcome back.");
  });

  it("renders actions and a leading icon when provided", () => {
    render(
      h(PageHeader, {
        title: "Analytics",
        icon: Package,
        actions: h("button", null, "Export"),
      }),
    );
    const btn = container!.querySelector("button");
    expect(btn?.textContent).toBe("Export");
    // The icon prop renders an inline <svg> (lucide) in the header.
    expect(container!.querySelector("svg")).toBeTruthy();
  });

  it("omits the subtitle and actions wrapper when not given", () => {
    render(h(PageHeader, { title: "Settings" }));
    expect(container!.querySelector("p")).toBeNull();
    expect(container!.querySelector("button")).toBeNull();
  });
});
