// US-3183: the results view, and the sentences it must never print.
//
// The arithmetic is held by src/lib/work-scorecard.test.ts. What is asserted
// here is what reaches the SCREEN: that an unavailable figure renders its
// reason rather than a zero, that the unsold work is beside the wins, that
// the hourly caveat is attached rather than hidden, and that no wording
// anywhere claims the planner caused anything.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Outcome, PlannedTask } from "@/lib/work-outcomes";

const NOW = "2026-03-20T12:00:00.000Z";
const MARCH = "2026-03-10T12:00:00.000Z";

let bookState: {
  data?: { outcomes: Outcome[]; tasks: PlannedTask[]; now: string };
  isLoading: boolean;
  isError: boolean;
} = { data: undefined, isLoading: true, isError: false };

vi.mock("@/hooks/use-planner", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/hooks/use-planner");
  return { ...actual, useWorkOutcomes: () => bookState };
});

const { ResultsPanel } = await import("@/components/flipdesk/results-panel");

function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    inventoryItemId: "item-1",
    state: "sold",
    estimatedNetCents: 3000,
    estimateSource: "sold_comp",
    estimatedAt: MARCH,
    confirmedMinutes: 30,
    sessionCount: 1,
    recordedNetCents: 4000,
    incompleteReason: null,
    saleId: "sale-1",
    marketplace: "ebay",
    soldAt: MARCH,
    ageDays: 3,
    ...over,
  };
}

function task(over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId: "t1",
    sessionId: "s1",
    inventoryItemId: "item-1",
    itemTitleSnapshot: null,
    actionKey: "photograph",
    taskState: "done",
    sessionState: "completed",
    estimateValueCents: 3000,
    estimateSource: "sold_comp",
    estimateTakenAt: MARCH,
    confirmedMinutes: 30,
    correctionMinutes: null,
    ...over,
  };
}

function loaded(outcomes: Outcome[], tasks: PlannedTask[]) {
  bookState = { data: { outcomes, tasks, now: NOW }, isLoading: false, isError: false };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  act(() => {
    root = createRoot(container!);
    root.render(h(QueryClientProvider, { client: qc }, h(ResultsPanel)));
  });
  const d = container.querySelector("details");
  act(() => {
    if (d) d.open = true;
  });
}

function body(): string {
  return container?.textContent ?? "";
}

async function click(text: string | RegExp): Promise<void> {
  const el = Array.from(document.querySelectorAll("button")).find((b) => {
    const t = b.textContent?.trim() ?? "";
    return typeof text === "string" ? t === text : text.test(t);
  });
  if (!el) throw new Error(`no button named ${String(text)}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  bookState = { data: undefined, isLoading: true, isError: false };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("the three figures (AC2)", () => {
  it("prints projection, recorded money and the rate, each labelled", () => {
    loaded([outcome()], [task()]);
    render();
    expect(body()).toContain("What the planner guessed");
    expect(body()).toContain("$30.00");
    expect(body()).toContain("What the books recorded");
    expect(body()).toContain("$40.00");
    expect(body()).toContain("Profit per tracked hour");
    expect(body()).toContain("$80.00");
  });

  it("the hourly caveat is ON the screen, not behind a tooltip", () => {
    loaded([outcome()], [task()]);
    render();
    expect(body()).toContain("Only counts minutes you confirmed");
    expect(body()).toContain("lower than this");
    expect(container!.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("never says earned, saved, guaranteed or hourly rate", () => {
    // THE WHOLE STORY IN ONE ASSERTION. Every one of these would be a claim
    // this data cannot support, and each is what the tempting version of this
    // screen prints.
    loaded([outcome()], [task()]);
    render();
    for (const banned of [
      /\bearn/i, /\bsaved\b/i, /guaranteed/i, /your hourly rate/i,
      /thanks to/i, /because of the planner/i, /made you/i,
    ]) {
      expect(banned.test(body()), `screen matched ${banned}`).toBe(false);
    }
  });
});

describe("unavailable renders the reason, never a zero (AC3)", () => {
  it("says so when nothing has sold", () => {
    loaded(
      [outcome({ state: "pending", recordedNetCents: null, saleId: null })],
      [task({ taskState: "pending" })],
    );
    render();
    expect(body()).toContain("Nothing from this work has sold yet.");
    expect(body()).not.toContain("$0.00 ");
  });

  it("says so when the costs were never recorded", () => {
    loaded(
      [outcome({ state: "incomplete_costs", recordedNetCents: null })],
      [task()],
    );
    render();
    expect(body()).toContain("costs on these sales were never recorded");
    expect(body()).toContain("1 sold item is left out above");
  });

  it("says so when there are no confirmed minutes, and prints no Infinity", () => {
    loaded([outcome({ confirmedMinutes: 0 })], [task({ confirmedMinutes: null })]);
    render();
    expect(body()).toContain("no confirmed minutes against these sales");
    expect(body()).not.toContain("Infinity");
    expect(body()).not.toContain("NaN");
  });
});

describe("the unsold half is beside the wins (AC3)", () => {
  it("shows the count and the hours already in it", () => {
    loaded(
      [
        outcome(),
        outcome({ inventoryItemId: "i2", state: "pending", recordedNetCents: null, confirmedMinutes: 90 }),
      ],
      [task()],
    );
    render();
    expect(body()).toContain("Still waiting to sell");
    expect(body()).toContain("1 item, with 1 hr 30 min already in them");
    expect(body()).toContain("can't look good by leaving it out");
  });
});

describe("forecast versus actual (AC4)", () => {
  it("reports the sample size, the range and the evidence type", () => {
    loaded(
      [
        outcome({ estimatedNetCents: 3000, recordedNetCents: 4000 }),
        outcome({ inventoryItemId: "i2", estimatedNetCents: 5000, recordedNetCents: 2000, estimateSource: "active_asking" }),
      ],
      [task()],
    );
    render();
    expect(body()).toContain("On 2 items");
    expect(body()).toContain("-$30.00");
    expect(body()).toContain("1 sold comp");
    expect(body()).toContain("1 active asking");
    expect(body()).toContain("30-day selling window");
  });

  it("hedges a thin sample rather than reporting it flat", () => {
    loaded([outcome()], [task()]);
    render();
    expect(body()).toContain("small number of sales");
  });

  it("a two-period comparison says plainly that it shows no cause", async () => {
    loaded([outcome()], [task()]);
    render();
    await click(/Compare with the period before/);
    expect(body()).toContain("The period before");
    expect(body()).toContain("doesn't show that one caused the other");
  });
});

describe("loading, empty and error (AC7)", () => {
  it("says it is reading rather than showing an empty scorecard", () => {
    render();
    expect(body()).toContain("Reading your history");
    expect(body()).not.toContain("Profit per tracked hour");
  });

  it("an error says nothing is lost", () => {
    bookState = { data: undefined, isLoading: false, isError: true };
    render();
    expect(container!.querySelector('[role="alert"]')?.textContent)
      .toContain("Nothing is lost");
  });

  it("an empty history reports no work rather than zeroes", () => {
    loaded([], []);
    render();
    expect(body()).toContain("No planned work in these dates.");
  });
});

describe("keyboard and shape (AC7)", () => {
  it("is a native disclosure with a labelled date range", () => {
    loaded([outcome()], [task()]);
    render();
    expect(container!.querySelector("details")).not.toBeNull();
    expect(container!.querySelector("summary")?.textContent)
      .toContain("How the planner has done for you");
    for (const id of ["wmt-from", "wmt-to"]) {
      expect(container!.querySelector(`label[for="${id}"]`)).not.toBeNull();
      expect(container!.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("the compare control reports its own pressed state", () => {
    loaded([outcome()], [task()]);
    render();
    const btn = Array.from(document.querySelectorAll("button"))
      .find((b) => /Compare with/.test(b.textContent ?? ""))!;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });
});
