import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorState } from "@/components/ui/error-state";
import { QueryBoundary } from "@/components/ui/query-boundary";

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

describe("ErrorState", () => {
  it("renders an alert with retry + support contact", () => {
    const onRetry = vi.fn();
    render(h(ErrorState, { onRetry }));
    const alert = container!.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(container!.querySelector('a[href="mailto:support@gradethread.com"]')).toBeTruthy();
    const btn = container!.querySelector("button");
    expect(btn).toBeTruthy();
    act(() => btn!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits the retry button when no handler is given", () => {
    render(h(ErrorState, {}));
    expect(container!.querySelector("button")).toBeNull();
  });

  it("disables retry and shows Retrying… while a retry is in flight", () => {
    render(h(ErrorState, { onRetry: () => {}, retrying: true }));
    const btn = container!.querySelector("button");
    expect(btn?.hasAttribute("disabled")).toBe(true);
    expect(container!.textContent).toContain("Retrying");
  });
});

describe("QueryBoundary", () => {
  const slots = {
    loading: h("p", null, "LOADING"),
    empty: h("p", null, "EMPTY"),
    children: h("p", null, "CONTENT"),
  };

  it("shows the error state — not empty — when isError, separate from empty", () => {
    const onRetry = vi.fn();
    render(
      h(
        QueryBoundary,
        { isLoading: false, isError: true, isEmpty: true, onRetry, empty: slots.empty },
        slots.children,
      ),
    );
    expect(container!.querySelector('[role="alert"]')).toBeTruthy();
    expect(container!.textContent).not.toContain("EMPTY");
    expect(container!.textContent).not.toContain("CONTENT");
  });

  it("shows loading first, then empty, then content", () => {
    render(
      h(
        QueryBoundary,
        { isLoading: true, isError: false, loading: slots.loading, empty: slots.empty },
        slots.children,
      ),
    );
    expect(container!.textContent).toContain("LOADING");

    render(
      h(
        QueryBoundary,
        { isLoading: false, isError: false, isEmpty: true, empty: slots.empty },
        slots.children,
      ),
    );
    expect(container!.textContent).toContain("EMPTY");

    render(
      h(
        QueryBoundary,
        { isLoading: false, isError: false, isEmpty: false },
        slots.children,
      ),
    );
    expect(container!.textContent).toContain("CONTENT");
  });
});
