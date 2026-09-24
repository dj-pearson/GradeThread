// Worth My Time, R2 05/06 (US-3182): the correction panel.
//
// The rules underneath are held by src/lib/work-overrides.test.ts. What is
// asserted here is the WIRING, and the four things a plausible implementation
// gets wrong: it sends a price to the wrong route, it sends a snooze length
// the client chose, it swallows a bad number, and it hides a parcel that has
// to ship.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Args = Record<string, unknown>;
type Call = (a: Args) => Promise<Record<string, unknown>>;
const saveMutate = vi.fn<Call>(() => Promise.resolve({}));
const resetMutate = vi.fn<Call>(() => Promise.resolve({}));
const suppressMutate = vi.fn<Call>(() => Promise.resolve({}));
const unsuppressMutate = vi.fn<Call>(() => Promise.resolve({}));
const toastErrorMock = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let liveBook: any = null;

vi.mock("@/lib/toast-error", () => ({ toastError: toastErrorMock }));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: toastSuccess },
}));
vi.mock("@/hooks/use-planner", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/hooks/use-planner");
  return {
    ...actual,
    useSaveOverride: () => ({ mutateAsync: saveMutate, isPending: false }),
    useResetOverride: () => ({ mutateAsync: resetMutate, isPending: false }),
    useSuppress: () => ({ mutateAsync: suppressMutate, isPending: false }),
    useResetSuppression: () => ({ mutateAsync: unsuppressMutate, isPending: false }),
    // WMT-08: the panel reads the LIVE book itself.
    useWorkOverrides: () => ({ data: liveBook }),
  };
});

const { TaskCorrections } = await import("@/components/flipdesk/task-corrections");

const NOW = "2026-09-21T12:00:00.000Z";

function daysFromNow(n: number): string {
  return new Date(Date.parse(NOW) + n * 86_400_000).toISOString();
}

function book(over: Record<string, unknown> = {}) {
  return { overrides: [], suppressions: [], now: NOW, ...over };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

let qcForTest: QueryClient | null = null;

function tree(props: Record<string, unknown>) {
  return h(
    QueryClientProvider,
    { client: qcForTest! },
    h(TaskCorrections, {
      itemId: "item-1",
      actionKey: "photograph",
      estimateMinutes: 8,
      remainingBudgetMinutes: 30,
      ...props,
    } as never),
  );
}

/** Re-render as the live query would after an invalidation, or with a new task. */
function rerender(props: Record<string, unknown> = {}): void {
  act(() => root!.render(tree(props)));
  const d = container!.querySelector("details");
  act(() => {
    if (d) d.open = true;
  });
}

function render(props: Record<string, unknown> = {}): void {
  const { book: given, ...rest } = props;
  liveBook = given ?? book();
  props = rest;
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qcForTest = qc;
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client: qc },
        h(TaskCorrections, {
          itemId: "item-1",
          actionKey: "photograph",
          estimateMinutes: 8,
          remainingBudgetMinutes: 30,
          ...props,
        } as never),
      ),
    );
  });
  // The panel is a native <details>. Open it so the controls are reachable,
  // the same way a seller clicking the summary would.
  const d = container.querySelector("details");
  act(() => {
    if (d) d.open = true;
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function click(text: string | RegExp, nth = 0): Promise<void> {
  const all = Array.from(document.querySelectorAll("button")).filter((b) => {
    const t = b.textContent?.trim() ?? "";
    return typeof text === "string" ? t === text : text.test(t);
  });
  const el = all[nth];
  if (!el) throw new Error(`no button named ${String(text)} at ${nth}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function type(selector: string, value: string): void {
  const el = container!.querySelector(selector) as HTMLInputElement;
  if (!el) throw new Error(`no field ${selector}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function body(): string {
  return container?.textContent ?? "";
}

beforeEach(() => {
  saveMutate.mockClear();
  resetMutate.mockClear();
  suppressMutate.mockClear();
  unsuppressMutate.mockClear();
  toastErrorMock.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("correcting an estimate (AC1, AC2)", () => {
  it("sends the minutes scoped to THIS step", async () => {
    render();
    type("[data-field=minutes]", "20");
    await click("Save", 0);
    expect(saveMutate).toHaveBeenCalledTimes(1);
    expect(saveMutate.mock.calls[0]![0]).toMatchObject({
      inventoryItemId: "item-1",
      actionKey: "photograph",
      kind: "task_minutes",
      amountMinutes: 20,
    });
  });

  it("keeps what it replaced, so reset has something to go back to", async () => {
    render();
    type("[data-field=minutes]", "20");
    await click("Save", 0);
    expect(saveMutate.mock.calls[0]![0]).toMatchObject({ original: { amount: 8 } });
  });

  it("shows the difference BEFORE it is saved", async () => {
    render({ remainingBudgetMinutes: 12 });
    type("[data-field=minutes]", "45");
    expect(body()).toContain("We said about 8 min. You're saying 45.");
    expect(body()).toContain("more than the time left");
    // Still not written: the preview is the point.
    expect(saveMutate).not.toHaveBeenCalled();
  });

  it("a change that fits is not flagged as not fitting", () => {
    render({ remainingBudgetMinutes: 30 });
    type("[data-field=minutes]", "12");
    expect(body()).toContain("We said about 8 min. You're saying 12.");
    expect(body()).not.toContain("more than the time left");
  });

  it("refuses zero minutes with a sentence, and sends nothing", async () => {
    render();
    type("[data-field=minutes]", "0");
    await click("Save", 0);
    expect(saveMutate).not.toHaveBeenCalled();
    expect(body()).toContain("Zero minutes isn't a real answer");
  });

  it("refuses a duration longer than a session rather than clamping it", async () => {
    render();
    type("[data-field=minutes]", "6000");
    await click("Save", 0);
    expect(saveMutate).not.toHaveBeenCalled();
    expect(body()).toContain("longer than a whole session");
  });

  it("refuses an inverted range and reports it once", async () => {
    render();
    type("[data-field=low]", "90");
    const highs = Array.from(container!.querySelectorAll("input"));
    const high = highs.find((i) =>
      i.getAttribute("aria-label")?.startsWith("Highest")
    ) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(high, "10");
      high.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save", 1);
    expect(saveMutate).not.toHaveBeenCalled();
    expect(body()).toContain("The low has to come first.");
  });
});

describe("a correction is not a price (AC1)", () => {
  it("says so on the screen, where a seller reads it", () => {
    render();
    expect(body()).toContain("doesn't change your listing price");
  });

  it("sends money at the ITEM, never scoped to one step", async () => {
    render();
    type("[data-field=cost]", "0");
    await click("Save", 2);
    expect(saveMutate.mock.calls[0]![0]).toMatchObject({
      kind: "remaining_cost",
      actionKey: null,
      amountCents: 0,
    });
  });

  it("accepts a recorded zero cost, which a duration may not be", async () => {
    render();
    type("[data-field=cost]", "0");
    await click("Save", 2);
    expect(saveMutate).toHaveBeenCalledTimes(1);
  });
});

describe("resetting (AC1)", () => {
  it("offers the reset only once something is corrected", () => {
    render();
    expect(body()).not.toContain("Use our estimate");
  });

  it("resets the one kind it names, scoped the same way it was saved", async () => {
    render({
      book: book({
        overrides: [{
          inventoryItemId: "item-1",
          actionKey: "photograph",
          kind: "task_minutes",
          value: { amount: 20 },
          originalValue: null,
          source: "seller",
          updatedAt: NOW,
        }],
      }),
    });
    expect(body()).toContain("Use our estimate");
    await click("Use our estimate", 0);
    expect(resetMutate.mock.calls[0]![0]).toEqual({
      inventoryItemId: "item-1",
      actionKey: "photograph",
      kind: "task_minutes",
    });
  });
});

describe("setting aside (AC3)", () => {
  it("offers skip only when there is a session to skip it in", () => {
    render();
    expect(body()).not.toContain("Skip for now");
    act(() => root?.unmount());
    container?.remove();
    render({ sessionId: "s1" });
    expect(body()).toContain("Skip for now");
  });

  it("sends the session with a skip, and no session with a snooze", async () => {
    render({ sessionId: "s1" });
    await click("Skip for now");
    expect(suppressMutate.mock.calls[0]![0]).toMatchObject({
      kind: "skip_session",
      sessionId: "s1",
    });
    suppressMutate.mockClear();
    await click("Not for a week");
    expect(suppressMutate.mock.calls[0]![0]).toMatchObject({
      kind: "snooze",
      sessionId: null,
    });
  });

  it("the panel does not CHOOSE a snooze length", async () => {
    // Scoped to what this panel hands the hook, and no further: the request
    // body is built one layer down, and asserting it from here passed a
    // sabotage that added `until: "9999-01-01"` to the POST. What actually
    // goes on the wire is held by use-planner-overrides.test.ts.
    render();
    await click("Not for a week");
    const sent = JSON.stringify(suppressMutate.mock.calls[0]![0]);
    expect(sent).not.toContain("until");
    expect(sent).not.toContain("days");
  });

  it("dismiss covers the whole garment, not one step", async () => {
    render();
    await click("Stop suggesting this");
    expect(suppressMutate.mock.calls[0]![0]).toMatchObject({
      kind: "dismiss",
      actionKey: null,
    });
  });

  it("says plainly that nothing was sold, archived or deleted", () => {
    render();
    expect(body()).toContain("Your item stays where it is");
  });

  it("shows the state and a way back once something is set aside", async () => {
    render({
      book: book({
        suppressions: [{
          inventoryItemId: "item-1",
          actionKey: null,
          kind: "snooze",
          sessionId: null,
          until: daysFromNow(3),
          createdAt: NOW,
        }],
      }),
    });
    expect(body()).toContain("Set aside for a week.");
    await click("Put it back");
    // WMT-02: the reset names the row it undoes, so nothing else goes with it.
    expect(unsuppressMutate.mock.calls[0]![0]).toEqual({
      inventoryItemId: "item-1",
      kind: "snooze",
      actionKey: null,
      sessionId: null,
    });
  });

  it("putting back a skip leaves the item-wide dismiss and other steps alone", async () => {
    // A skip on this step and a snooze on another. The panel shows the skip,
    // and "Put it back" must reset only that one row.
    render({
      sessionId: "sess-1",
      book: book({
        suppressions: [
          {
            inventoryItemId: "item-1",
            actionKey: "photograph",
            kind: "skip_session",
            sessionId: "sess-1",
            until: null,
            createdAt: NOW,
          },
          {
            inventoryItemId: "item-1",
            actionKey: "measure",
            kind: "snooze",
            sessionId: null,
            until: daysFromNow(3),
            createdAt: NOW,
          },
        ],
      }),
    });
    await click("Put it back");
    expect(unsuppressMutate).toHaveBeenCalledTimes(1);
    expect(unsuppressMutate.mock.calls[0]![0]).toEqual({
      inventoryItemId: "item-1",
      kind: "skip_session",
      actionKey: "photograph",
      sessionId: "sess-1",
    });
  });

  it("an expired snooze reads as expired rather than as nothing", () => {
    render({
      book: book({
        suppressions: [{
          inventoryItemId: "item-1",
          actionKey: null,
          kind: "snooze",
          sessionId: null,
          until: daysFromNow(-1),
          createdAt: NOW,
        }],
      }),
    });
    expect(body()).toContain("Your week is up");
    expect(body()).toContain("Not for a week");
  });
});

describe("a deadline beats every set-aside (AC3)", () => {
  it("says so on the screen when the parcel outranks the snooze", () => {
    // THE MOST IMPORTANT CASE IN THIS FILE. A buyer has paid and the clock is
    // the marketplace's. A seller who snoozed last week did not agree to miss
    // a ship-by date this week, and a panel that stayed quiet about it would
    // let them find out from a late-shipment metric.
    render({
      urgentShipping: true,
      book: book({
        suppressions: [{
          inventoryItemId: "item-1",
          actionKey: null,
          kind: "dismiss",
          sessionId: null,
          until: null,
          createdAt: NOW,
        }],
      }),
    });
    expect(body()).toContain("back on the list even though you set it aside");
  });

  it("and the seller can still undo the set-aside on that evening", () => {
    render({
      urgentShipping: true,
      book: book({
        suppressions: [{
          inventoryItemId: "item-1",
          actionKey: null,
          kind: "dismiss",
          sessionId: null,
          until: null,
          createdAt: NOW,
        }],
      }),
    });
    expect(body()).toContain("Put it back");
  });
});

describe("keyboard and failure (AC7)", () => {
  it("is a native disclosure, so it opens with no handler of ours", () => {
    render();
    const d = container!.querySelector("details");
    const summary = container!.querySelector("summary");
    expect(d).not.toBeNull();
    expect(summary?.textContent).toContain("Change or set aside");
  });

  it("every field has a label a screen reader can read", () => {
    render();
    for (const input of Array.from(container!.querySelectorAll("input"))) {
      const labelled = input.getAttribute("aria-label") ??
        (input.id ? container!.querySelector(`label[for="${input.id}"]`)?.textContent : null);
      expect(labelled, `unlabelled field ${input.id}`).toBeTruthy();
    }
  });

  it("a failed save says so and leaves the typed number alone", async () => {
    saveMutate.mockRejectedValueOnce(new Error("nope"));
    render();
    type("[data-field=minutes]", "20");
    await click("Save", 0);
    expect(toastErrorMock).toHaveBeenCalled();
    const el = container!.querySelector("[data-field=minutes]") as HTMLInputElement;
    expect(el.value).toBe("20");
  });
});

describe("the live book and a fresh panel per task (WMT-08)", () => {
  const MINUTES_OVERRIDE = {
    inventoryItemId: "item-1",
    actionKey: "photograph",
    kind: "task_minutes",
    value: { amount: 20, lowCents: null, highCents: null },
    originalValue: null,
    source: "seller",
    updatedAt: NOW,
  };

  it("after a save, 'Use our estimate' appears without a rebuild", async () => {
    render();
    expect(body()).not.toContain("Use our estimate");
    saveMutate.mockImplementationOnce(() => {
      liveBook = book({ overrides: [MINUTES_OVERRIDE] });
      return Promise.resolve({});
    });
    type("[data-field=minutes]", "20");
    await click("Save");
    rerender();
    expect(body()).toContain("Use our estimate");
  });

  it("after a snooze, 'Put it back' appears, and the toast can undo it", async () => {
    render();
    suppressMutate.mockImplementationOnce(() => {
      liveBook = book({
        suppressions: [{
          inventoryItemId: "item-1",
          actionKey: "photograph",
          kind: "snooze",
          sessionId: null,
          until: daysFromNow(7),
          createdAt: NOW,
        }],
      });
      return Promise.resolve({});
    });
    await click("Not for a week");
    rerender();
    expect(body()).toContain("Put it back");
    const opts = toastSuccess.mock.calls[toastSuccess.mock.calls.length - 1]![1] as {
      action: { label: string; onClick: () => void };
    };
    expect(opts.action.label).toBe("Undo");
    await act(async () => {
      opts.action.onClick();
    });
    expect(unsuppressMutate.mock.calls[unsuppressMutate.mock.calls.length - 1]![0]).toEqual({
      inventoryItemId: "item-1",
      kind: "snooze",
      actionKey: "photograph",
      sessionId: null,
    });
  });

  it("moving to the next task clears what was typed for the last one", () => {
    render();
    type("[data-field=minutes]", "17");
    type("[data-field=cost]", "4");
    rerender({ itemId: "item-2", actionKey: "measure" });
    const min = container!.querySelector("[data-field=minutes]") as HTMLInputElement;
    const cost = container!.querySelector("[data-field=cost]") as HTMLInputElement;
    expect(min.value).toBe("");
    expect(cost.value).toBe("");
  });

  it("'$1,200' is money, not a typo", async () => {
    render();
    type("[data-field=cost]", "$1,200");
    await click("Save", 2);
    expect(saveMutate.mock.calls[0]![0]).toMatchObject({
      kind: "remaining_cost",
      amountCents: 120000,
    });
  });

  it("half minutes are refused with a sentence, and nothing is sent", async () => {
    render();
    type("[data-field=minutes]", "7.5");
    await click("Save");
    expect(body()).toContain("Use whole minutes.");
    expect(saveMutate).not.toHaveBeenCalled();
    const min = container!.querySelector("[data-field=minutes]")!;
    expect(min.getAttribute("aria-invalid")).toBe("true");
    const described = min.getAttribute("aria-describedby")!;
    expect(document.getElementById(described)?.textContent).toContain("Use whole minutes.");
  });

  it("Enter in the minutes field saves", async () => {
    render();
    type("[data-field=minutes]", "20");
    const form = container!.querySelector("[data-field=minutes]")!.closest("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(saveMutate).toHaveBeenCalledTimes(1);
  });
});
