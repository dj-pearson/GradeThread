import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Package } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

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
    root.render(h(MemoryRouter, null, node));
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

describe("EmptyState", () => {
  it("renders the no-data state with a routed primary CTA", () => {
    render(
      h(EmptyState, {
        icon: Package,
        title: "No inventory items yet",
        description: "Add your first item to start tracking.",
        action: { label: "Add your first item", to: "/dashboard/inventory/new" },
      }),
    );
    expect(container!.textContent).toContain("No inventory items yet");
    expect(container!.textContent).toContain("Add your first item");
    const link = container!.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/dashboard/inventory/new");
  });

  it("renders a no-matches state with a Clear filters secondary action", () => {
    const onClear = vi.fn();
    render(
      h(EmptyState, {
        title: "No matching items",
        description: "Try a different search or clear the filters.",
        secondaryAction: { label: "Clear filters", onClick: onClear },
      }),
    );
    const buttons = Array.from(container!.querySelectorAll("button"));
    const clearBtn = buttons.find((b) => b.textContent?.includes("Clear filters"));
    expect(clearBtn).toBeTruthy();
    act(() => {
      clearBtn!.click();
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("renders title only when no actions are given", () => {
    render(h(EmptyState, { title: "Nothing here" }));
    expect(container!.textContent).toContain("Nothing here");
    expect(container!.querySelector("button")).toBeNull();
    expect(container!.querySelector("a")).toBeNull();
  });
});
