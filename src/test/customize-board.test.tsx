import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutEntry, WidgetDef } from "@/lib/dashboard-widgets";
import { widgetsForSurface } from "@/lib/dashboard-widgets";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { CustomizableWidgetBoard } from "@/components/dashboard/customize-board";
import { leavesBoard } from "@/lib/dashboard-layout";

// DASH-4: Customize cannot overwrite the saved layout, lose edits on a failed
// save, or trip the leave guard on a range change.

const registry = widgetsForSurface("grading");
const LAYOUT: LayoutEntry[] = registry.slice(0, 3).map((w) => ({
  id: w.id,
  size: w.defaultSize,
}));

const state = vi.hoisted(() => ({
  isFromServer: true,
  isError: false,
  refetch: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock("@/hooks/use-dashboard-layout", async () => {
  const { widgetsForSurface } = await import("@/lib/dashboard-widgets");
  const reg = widgetsForSurface("grading");
  const layout = reg.slice(0, 3).map((w) => ({ id: w.id, size: w.defaultSize }));
  return {
    useDashboardLayout: () => ({
      layout,
      registry: reg,
      persona: "seller",
      context: {},
      isLoading: false,
      isFromServer: state.isFromServer,
      isError: state.isError,
      refetch: state.refetch,
    }),
    useSaveDashboardLayout: () => ({
      mutateAsync: state.mutateAsync,
      isPending: false,
    }),
  };
});
vi.mock("@/components/dashboard/attention-rail", () => ({
  AttentionRail: () => <div data-testid="rail" />,
}));
vi.mock("@/components/dashboard/widget-board", () => ({
  WidgetBoard: ({
    layout,
    registry,
    renderAction,
  }: {
    layout: LayoutEntry[];
    registry: WidgetDef[];
    renderAction?: (def: WidgetDef, entry: LayoutEntry) => React.ReactNode;
  }) => (
    <div data-testid="board">
      {layout.map((entry) => {
        const def = registry.find((w) => w.id === entry.id)!;
        return (
          <div key={entry.id} data-widget={entry.id}>
            {renderAction?.(def, entry)}
          </div>
        );
      })}
    </div>
  ),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.isFromServer = true;
  state.isError = false;
  state.refetch = vi.fn();
  state.mutateAsync = vi.fn().mockResolvedValue(LAYOUT);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function render() {
  router = createMemoryRouter(
    [
      {
        path: "/dashboard",
        element: (
          <ConfirmProvider>
            <CustomizableWidgetBoard
              surface="grading"
              title="Overview"
              actions={<span data-testid="range-picker">range</span>}
            />
          </ConfirmProvider>
        ),
      },
    ],
    { initialEntries: ["/dashboard?view=grading&range=d7"] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
}

function button(name: string): HTMLButtonElement {
  const b = [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === name || el.getAttribute("aria-label") === name,
  );
  if (!b) throw new Error(`no button "${name}"`);
  return b as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

function order(): string[] {
  return [...container.querySelectorAll("[data-widget]")].map(
    (el) => el.getAttribute("data-widget")!,
  );
}

async function moveFirstDown() {
  const first = registry.find((w) => w.id === LAYOUT[0]!.id)!;
  await click(button(`Move ${first.title} down`));
}

describe("CustomizableWidgetBoard (DASH-4)", () => {
  it("disables Customize until the server has answered", async () => {
    state.isFromServer = false;
    await render();
    expect(button("Customize").disabled).toBe(true);
  });

  it("offers Reload layout, not a forever-spinning Customize, when the read failed", async () => {
    state.isFromServer = false;
    state.isError = true;
    await render();
    expect(container.textContent).not.toContain("Customize");
    await click(button("Reload layout"));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it("Done with no change makes no write and leaves edit mode", async () => {
    await render();
    await click(button("Customize"));
    await click(button("Done"));
    expect(state.mutateAsync).not.toHaveBeenCalled();
    expect(button("Customize")).toBeTruthy();
  });

  it("hides the page actions (the range picker) while editing", async () => {
    await render();
    expect(container.querySelector('[data-testid="range-picker"]')).not.toBeNull();
    await click(button("Customize"));
    expect(container.querySelector('[data-testid="range-picker"]')).toBeNull();
  });

  it("a range change while editing opens no dialog and keeps the draft", async () => {
    await render();
    await click(button("Customize"));
    await moveFirstDown();
    const moved = order();
    expect(moved[1]).toBe(LAYOUT[0]!.id);
    await act(async () => {
      await router.navigate("/dashboard?view=grading&range=d30");
    });
    expect(router.state.location.search).toContain("range=d30");
    expect(document.body.textContent).not.toContain("Leave without saving");
    expect(order()).toEqual(moved);
    expect(button("Done")).toBeTruthy();
  });

  it("a view change while editing does open the leave dialog", async () => {
    await render();
    await click(button("Customize"));
    await moveFirstDown();
    await act(async () => {
      await router.navigate("/dashboard?view=flipdesk");
    });
    expect(document.body.textContent).toContain("Leave without saving");
  });

  it("a failed save keeps edit mode and the draft", async () => {
    state.mutateAsync = vi.fn().mockRejectedValue(new Error("offline"));
    await render();
    await click(button("Customize"));
    await moveFirstDown();
    const moved = order();
    await click(button("Done"));
    expect(state.mutateAsync).toHaveBeenCalledTimes(1);
    expect(button("Done")).toBeTruthy();
    expect(order()).toEqual(moved);
  });

  it("a successful save leaves edit mode", async () => {
    await render();
    await click(button("Customize"));
    await moveFirstDown();
    await click(button("Done"));
    expect(state.mutateAsync).toHaveBeenCalledTimes(1);
    expect(button("Customize")).toBeTruthy();
  });
});

describe("leavesBoard", () => {
  const loc = (pathname: string, search: string) =>
    ({ pathname, search, hash: "", state: null, key: "k" }) as const;

  it("ignores a range change and catches a view or page change", () => {
    expect(leavesBoard(loc("/dashboard", "?range=d7"), loc("/dashboard", "?range=d30")))
      .toBe(false);
    expect(leavesBoard(loc("/dashboard", "?view=grading"), loc("/dashboard", "?view=flipdesk")))
      .toBe(true);
    expect(leavesBoard(loc("/dashboard", ""), loc("/dashboard/settings", ""))).toBe(true);
  });
});
