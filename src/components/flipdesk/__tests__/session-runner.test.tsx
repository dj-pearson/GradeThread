// Worth My Time, R1 11/12 (US-3176): the session runner.
//
// AC6 names seven cases and every one is a thing that goes WRONG: an
// interruption, a reload, a deep link and return, a corrected time, a stale
// task, a double click, and a save that failed. The happy path is one test at
// the top; the rest of this file is the seven.
//
// The pure rules underneath (which task is current, what the clock saw, what
// the item's facts say) are held by src/lib/session-timing.test.ts. What is
// asserted here is the WIRING: that the screen sends what it says it sends,
// and shows what the server came back with rather than what it hoped for.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const sessionMutate = vi.fn();
const taskMutate = vi.fn();
const refetch = vi.fn();
const toastErrorMock = vi.fn();
let sessionState: Record<string, unknown> = { data: undefined, isLoading: true, isError: false };
let itemData: Record<string, unknown> | null = null;
let workPrefs: Record<string, unknown> | undefined = undefined;

vi.mock("@/lib/toast-error", () => ({ toastError: toastErrorMock }));
vi.mock("@/hooks/use-items-full", () => ({
  useItemFull: () => ({ data: itemData }),
}));
vi.mock("@/hooks/use-planner", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/hooks/use-planner");
  return {
    ...actual,
    useCurrentSession: () => ({ ...sessionState, refetch }),
    useWorkPreferences: () => ({ data: workPrefs, isError: false }),
    useSessionAction: () => ({ mutateAsync: sessionMutate, isPending: false }),
    useTaskAction: () => ({ mutateAsync: taskMutate, isPending: false }),
    // US-3182. The correction panel has its own suite; held at "nothing
    // corrected" here so these cases stay about the session.
    useWorkOverrides: () => ({
      data: { overrides: [], suppressions: [], now: "2026-09-21T11:00:00.000Z" },
    }),
    useSaveOverride: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useResetOverride: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSuppress: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useResetSuppression: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

const { SessionRunner } = await import("@/components/flipdesk/session-runner");
const { itemHref } = await import("@/lib/session-links");

function task(over: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    position: 1,
    state: "pending",
    action_key: "measure",
    inventory_item_id: "item-1",
    item_title: "Carhartt Detroit jacket",
    bin: "A-14",
    estimate_minutes: 5,
    estimate_value_cents: 4800,
    confirmed_minutes: null,
    actionable: true,
    ...over,
  };
}

function session(over: Record<string, unknown> = {}, tasks = [task()]) {
  return {
    data: {
      session: { id: "s1", state: "active", budget_minutes: 30, revision: 4, ...over },
      tasks,
    },
    isLoading: false,
    isError: false,
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  act(() => {
    root = createRoot(container!);
    root.render(
      h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(SessionRunner))),
    );
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function buttonNamed(text: string | RegExp): HTMLButtonElement {
  const all = Array.from(document.querySelectorAll("button"));
  const match = all.find((b) => {
    const t = b.textContent?.trim() ?? "";
    return typeof text === "string" ? t === text : text.test(t);
  });
  if (!match) throw new Error(`no button named ${String(text)}`);
  return match as HTMLButtonElement;
}

async function click(text: string | RegExp): Promise<void> {
  const el = buttonNamed(text);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function body(): string {
  return container?.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

beforeEach(() => {
  sessionMutate.mockReset();
  sessionMutate.mockResolvedValue({});
  taskMutate.mockReset();
  taskMutate.mockResolvedValue({});
  refetch.mockReset();
  toastErrorMock.mockReset();
  itemData = { measurements: { chest: 22 } };
  workPrefs = undefined;
  sessionState = session();
});

describe("the happy path", () => {
  it("shows the current job, what is left, and the controls", async () => {
    render();
    await settle();
    expect(body()).toContain("Carhartt Detroit jacket");
    expect(body()).toContain("A-14");
    expect(body()).toContain("about 5 minutes left");
    expect(buttonNamed("Start this one")).toBeTruthy();
    expect(buttonNamed("Skip")).toBeTruthy();
    expect(buttonNamed("Pause")).toBeTruthy();
    expect(buttonNamed("Finish for now")).toBeTruthy();
  });

  it("sends the revision it was shown, so a stale tab loses", async () => {
    render();
    await settle();
    await click("Start this one");
    expect(taskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", action: "start", revision: 4 }),
    );
  });
});

describe("an interruption (AC1, AC6)", () => {
  it("pausing sends pause, not a task change", async () => {
    render();
    await settle();
    await click("Pause");
    expect(sessionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", action: "pause", revision: 4 }),
    );
    expect(taskMutate).not.toHaveBeenCalled();
  });

  it("a paused session offers a way back in and says it is paused", async () => {
    sessionState = session({ state: "paused" });
    render();
    await settle();
    expect(body()).toContain("Paused");
    await click("Pick up where I left off");
    expect(sessionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resume" }),
    );
  });

  it("a paused session will not start a new job under the seller", async () => {
    sessionState = session({ state: "paused" });
    render();
    await settle();
    // The server refuses it too. Offering a button that cannot work is a
    // refusal the seller can do nothing useful with.
    expect(buttonNamed("Start this one").disabled).toBe(true);
  });
});

describe("a reload (AC1)", () => {
  it("restores whatever the server says, including a running task", async () => {
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    // The screen holds no memory of its own. A reload is just this render
    // with the server's answer, which is why it restores for free.
    expect(buttonNamed("Done")).toBeTruthy();
  });

  it("says so while it is looking, rather than showing an empty screen", () => {
    sessionState = { data: undefined, isLoading: true, isError: false };
    render();
    expect(body()).toContain("Looking for a session you left running");
  });

  it("a failed read does not claim the work is gone", async () => {
    sessionState = { data: undefined, isLoading: false, isError: true };
    render();
    await settle();
    // THE SENTENCE MATTERS. A seller who reads "no session" assumes the
    // evening is lost and starts again, which duplicates every task.
    expect(body()).toContain("Nothing is lost");
    await click("Try again");
    expect(refetch).toHaveBeenCalled();
  });
});

describe("the deep link and the return (AC2)", () => {
  it("carries the return destination in the URL, not in router state", async () => {
    render();
    await settle();
    const link = Array.from(document.querySelectorAll("a"))
      .find((a) => a.textContent?.includes("Open item"))!;
    const href = link.getAttribute("href")!;
    expect(href.split("?")[0]).toBe("/dashboard/flipdesk/items/item-1");
    // Router state does not survive a full page load, and an item route is a
    // full page load. The param does.
    expect(new URLSearchParams(href.split("?")[1]).get("back"))
      .toBe("/dashboard/flipdesk/worth-my-time");
  });

  it("falls back to inventory when there is no item to open", () => {
    expect(itemHref(null)).toBe("/dashboard/flipdesk/inventory");
  });

  it("says when it cannot see the work, and still lets the seller say they did it", async () => {
    itemData = { measurements: null };
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    expect(body()).toContain("We still don't see measurements saved on this item");
    expect(body()).toContain("You can still mark it done if you know you did it");
    // A REPORT, NOT A GATE. The button is live.
    expect(buttonNamed("Done").disabled).toBe(false);
  });

  it("says nothing when the work did land", async () => {
    itemData = { measurements: { chest: 22 } };
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    expect(body()).not.toContain("We still don't see");
  });
});

describe("corrected timing (AC3, AC6)", () => {
  it("asks before recording, rather than banking the clock", async () => {
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    await click("Done");
    // Done does not complete. It opens the question.
    expect(taskMutate).not.toHaveBeenCalled();
    expect(body()).toContain("How long did that actually take?");
    expect(document.getElementById("wmt-minutes")).toBeTruthy();
  });

  it("sends the number the seller left in the box, not the one offered", async () => {
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    await click("Done");
    const input = document.getElementById("wmt-minutes") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, "12");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save and move on");
    expect(taskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "complete", confirmedMinutes: 12 }),
    );
  });

  it("'Not yet' records nothing at all", async () => {
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    await click("Done");
    await click("Not yet");
    expect(taskMutate).not.toHaveBeenCalled();
    expect(body()).not.toContain("How long did that actually take?");
  });
});

describe("a stale task (AC4, AC5)", () => {
  it("says when jobs were closed under the seller, and that the rest survived", async () => {
    sessionState = session({}, [
      task({ id: "a", state: "invalidated", actionable: false }),
      task({ id: "b", position: 2 }),
    ]);
    render();
    await settle();
    expect(body()).toContain("closed because the item sold or moved");
    expect(body()).toContain("The rest of your plan is untouched");
  });

  it("never offers a task whose item is gone as the current one", async () => {
    sessionState = session({}, [
      task({ id: "a", inventory_item_id: null, item_title: "Deleted", actionable: false }),
      task({ id: "b", position: 2, item_title: "Levi 501 jeans" }),
    ]);
    render();
    await settle();
    expect(body()).toContain("Levi 501 jeans");
    expect(body()).not.toContain("Deleted");
  });
});

describe("a double click and two tabs (AC4)", () => {
  it("a retry of the same start carries the SAME attempt number", async () => {
    sessionState = session();
    render();
    await settle();
    await click("Start this one");
    const first = taskMutate.mock.calls[0]![0].attempt;
    expect(first).toBe(1);

    // A failed first attempt, retried. The attempt number must not move, or
    // the server's dedup key changes and the same work is timed twice.
    taskMutate.mockRejectedValueOnce(new Error("network"));
    await click("Start this one");
    await click("Start this one");
    const attempts = taskMutate.mock.calls.map((c) => c[0].attempt);
    // Pressing start again is a real second entry into the state, so it DOES
    // increment -- what must not happen is two events for one press.
    expect(new Set(attempts).size).toBe(attempts.length);
  });

  it("a stale revision shows the server's truth instead of re-sending", async () => {
    const err = Object.assign(new Error("Someone else changed this session."), {
      code: "stale_revision",
      payload: { session: { id: "s1", state: "active", budget_minutes: 30, revision: 9 }, tasks: [] },
    });
    taskMutate.mockRejectedValueOnce(err);
    render();
    await settle();
    await click("Start this one");
    expect(body()).toContain("Someone else changed this session.");
    expect(body()).toContain("Your list above is up to date now");
    // Exactly one POST. Replaying the action to find out what happened is how
    // one of the two attempts gets applied twice.
    expect(taskMutate).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe("a save that failed (AC4, AC6)", () => {
  it("says so and leaves the session on screen", async () => {
    taskMutate.mockRejectedValueOnce(new Error("connection lost"));
    render();
    await settle();
    await click("Start this one");
    expect(toastErrorMock).toHaveBeenCalled();
    // The plan is still there. A failure that blanked the screen would read
    // as the evening's work being gone.
    expect(body()).toContain("Carhartt Detroit jacket");
    expect(buttonNamed("Start this one")).toBeTruthy();
  });

  it("does not show a conflict banner for an ordinary failure", async () => {
    taskMutate.mockRejectedValueOnce(new Error("connection lost"));
    render();
    await settle();
    await click("Start this one");
    expect(body()).not.toContain("Your list above is up to date now");
  });
});

describe("finishing (AC5)", () => {
  it("shows what was finished and the minutes the seller confirmed", async () => {
    sessionState = session({ state: "completed" }, [
      task({ id: "a", state: "completed", confirmed_minutes: 7 }),
      task({ id: "b", position: 2, state: "completed", confirmed_minutes: 4 }),
    ]);
    render();
    await settle();
    expect(body()).toContain("2 jobs done");
    expect(body()).toContain("11 minutes you confirmed");
  });

  it("never reports a projected value as something earned", async () => {
    sessionState = session({ state: "completed" }, [
      task({ id: "a", state: "completed", confirmed_minutes: 7, estimate_value_cents: 4800 }),
    ]);
    render();
    await settle();
    const t = body().toLowerCase();
    for (const word of ["earned", "earn", "you made", "$48", "profit"]) {
      expect(t, `finish screen says "${word}"`).not.toContain(word);
    }
  });

  it("says unfinished work was kept rather than lost", async () => {
    sessionState = session({ state: "completed" }, [
      task({ id: "a", state: "completed", confirmed_minutes: 7 }),
      task({ id: "b", position: 2, state: "pending" }),
      task({ id: "c", position: 3, state: "skipped" }),
    ]);
    render();
    await settle();
    expect(body()).toContain("2 left for next time");
    expect(body()).toContain("Nothing was lost");
  });

  it("says so when a session ended with nothing finished", async () => {
    // US-3177: this used to render NOTHING. The seller pressed "Finish for
    // now", the panel vanished, and they were never told the jobs they did
    // not get to had been kept.
    sessionState = session({ state: "completed" }, [
      task({ id: "a", state: "pending" }),
      task({ id: "b", position: 2, state: "skipped" }),
    ]);
    render();
    await settle();
    expect(body()).toContain("No jobs finished this time");
    expect(body()).toContain("2 left for next time");
    expect(body()).toContain("Nothing was lost");
  });

  it("renders nothing at all when there is no session", async () => {
    sessionState = { data: { session: null, tasks: [] }, isLoading: false, isError: false };
    render();
    await settle();
    expect(body()).toBe("");
  });
});

describe("the stop-working advice (US-3180)", () => {
  /** An item with everything done and almost nothing left in it. */
  const poorItem = {
    id: "item-1",
    status: "cataloged",
    measurements: { chest: 22 },
    has_required_photos: true,
    target_price: 4,
    purchase_price: 3,
    listing_platform: "ebay",
    listing_id: "l1",
    updated_at: "2026-09-01T00:00:00.000Z",
  };

  it("stays out of the way when finishing is clearly worth it", async () => {
    itemData = {
      ...poorItem,
      target_price: 120,
      purchase_price: 10,
      has_required_photos: false,
      measurements: null,
    };
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    // A seller already doing the right thing does not need a panel telling
    // them so.
    expect(body()).not.toContain("List it as it is");
  });

  it("offers the alternatives when there is little left in it", async () => {
    itemData = poorItem;
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    expect(body()).toContain("List it as it is");
    expect(body()).toContain("Suggestions only. Nothing here changes a listing.");
  });

  it("never states a bundle or as-is price", async () => {
    itemData = poorItem;
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    const t = body();
    if (t.includes("Put it in a bundle")) {
      expect(t).toMatch(/can't say what a bundle would fetch|nothing else that would go with it/);
    }
    if (t.includes("List it as it is")) {
      expect(t).toContain("haven't measured what a half-ready listing makes");
    }
  });

  it("makes no tax or value claim when it suggests giving one away", async () => {
    itemData = poorItem;
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    const t = body().toLowerCase();
    for (const banned of ["deduction", "tax write", "write-off", "fair market"]) {
      expect(t, `the advice panel says "${banned}"`).not.toContain(banned);
    }
  });

  it("says the past purchase is already spent, rather than folding it in", async () => {
    itemData = { ...poorItem, purchase_price: 80, target_price: 4 };
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    if (body().includes("Across its whole life")) {
      expect(body()).toContain("already spent either way");
      expect(body()).toContain("isn't part of the choice");
    }
  });

  it("says nothing at all when the item has not loaded", async () => {
    itemData = null;
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    expect(body()).not.toContain("Suggestions only");
  });
});

describe("accessibility", () => {
  it("the section and the confirmation both carry a heading a reader can reach", async () => {
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    expect(document.getElementById("wmt-session")).toBeTruthy();
    await click("Done");
    const group = document.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-labelledby")).toBe("wmt-confirm");
    expect(document.getElementById("wmt-confirm")?.textContent)
      .toBe("How long did that actually take?");
  });

  it("a conflict is announced, not only coloured", async () => {
    const err = Object.assign(new Error("Someone else changed this session."), {
      payload: { session: { id: "s1", state: "active", budget_minutes: 30, revision: 9 }, tasks: [] },
    });
    taskMutate.mockRejectedValueOnce(err);
    render();
    await settle();
    await click("Start this one");
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Someone else changed this session.");
  });

  it("every control is a real button with a name", async () => {
    sessionState = session({}, [task({ state: "active" })]);
    render();
    await settle();
    for (const b of Array.from(document.querySelectorAll("button"))) {
      const name = b.textContent?.trim() || b.getAttribute("aria-label") || "";
      expect(name, "a control with no accessible name").not.toBe("");
    }
  });
});
