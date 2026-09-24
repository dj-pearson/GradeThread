// WMT-06: the setup editor sends one field per save and goes read-only on 403.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";

const saveMock = vi.fn<(b: Record<string, unknown>) => Promise<unknown>>();
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/hooks/use-planner", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/hooks/use-planner");
  return {
    ...actual,
    useSaveWorkPreferences: () => ({ mutateAsync: saveMock, isPending: false }),
  };
});

const { WorkSetupEditor } = await import("@/components/flipdesk/work-setup-editor");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREFS = {
  defaultSessionMinutes: 30,
  workContext: "home" as const,
  availableTools: ["camera"],
  hourlyTargetAmount: 20,
  hourlyTargetSet: true,
  sessionMinutePresets: [15, 30, 60],
  minSessionMinutes: 5,
  maxSessionMinutes: 240,
  workTools: [],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onChanged = vi.fn();

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(h(WorkSetupEditor, { prefs: PREFS, onChanged }));
  });
}

async function click(name: string) {
  const b = Array.from(container!.querySelectorAll("button"))
    .find((x) => x.textContent?.trim() === name)!;
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  saveMock.mockReset();
  saveMock.mockResolvedValue({});
  onChanged.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("WorkSetupEditor", () => {
  it("clearing the hourly target sends only that field, as null", async () => {
    render();
    expect(container!.textContent).toContain("Now $20.00 an hour.");
    await click("Clear it");
    expect(saveMock.mock.calls).toEqual([[{ hourly_target_amount: null }]]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("the context toggle sends only work_context", async () => {
    render();
    await click("Away, phone only");
    expect(saveMock.mock.calls).toEqual([[{ work_context: "phone_only" }]]);
  });

  it("goes read-only after a 403 rather than offering changes that cannot land", async () => {
    saveMock.mockRejectedValue(Object.assign(new Error("no"), { status: 403 }));
    render();
    await click("Tape measure");
    expect(container!.textContent).toContain("Only the workspace owner can change this setup.");
    const chip = Array.from(container!.querySelectorAll("button"))
      .find((x) => x.textContent?.trim() === "Steamer")!;
    expect(chip.disabled).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
