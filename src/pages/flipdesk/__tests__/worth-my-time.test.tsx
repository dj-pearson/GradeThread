import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Worth My Time, R1 10/12 (US-3175).
//
// The pipeline under this page is already driven by its own suites, so what
// these cases hold is the SCREEN: what it says, what it refuses to say, and
// what it does when a request fails.

const buildMock = vi.fn();
const savePrefsMock = vi.fn(() => Promise.resolve({}));
const toastError = vi.fn();

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("@/hooks/use-planner", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/hooks/use-planner");
  return {
    ...actual,
    useWorkPreferences: () => ({
      data: {
        defaultSessionMinutes: 30,
        workContext: "home",
        availableTools: ["camera", "measuring_tape"],
        hourlyTargetAmount: null,
        hourlyTargetSet: false,
        sessionMinutePresets: [15, 30, 60],
        minSessionMinutes: 5,
        maxSessionMinutes: 240,
        workTools: [],
      },
      isError: false,
    }),
    useSaveWorkPreferences: () => ({ mutateAsync: savePrefsMock }),
    useBuildPlan: () => ({ mutateAsync: buildMock, isPending: false }),
  };
});

const { WorthMyTimePage } = await import("@/pages/flipdesk/worth-my-time");

function plan(over: Record<string, unknown> = {}) {
  return {
    plan: {
      tasks: [
        { key: "item-1:measure", itemId: "item-1", family: "measure", activeMinutes: 9, overheadMinutes: 2, startsAtMinute: 0 },
      ],
      plannedMinutes: 11,
      unusedMinutes: 19,
      omitted: [],
      conflicts: [],
      smallestEligibleMinutes: null,
      consideredCount: 1,
      version: 1,
    },
    ranked: [
      {
        key: "item-1:measure",
        itemId: "item-1",
        action: "measure",
        tier: "valued_work",
        score: 100,
        chainMinutes: 5,
        conservativeCents: 4800,
        dueAt: null,
        prerequisiteKeys: [],
        conflict: null,
        meetsHourlyTarget: null,
        version: 1,
      },
    ],
    candidates: [
      {
        key: "item-1:measure",
        itemId: "item-1",
        itemTitle: "Carhartt Detroit jacket",
        action: "measure",
        prerequisiteKeys: [],
        requiredContext: ["home"],
        requiredTools: ["measuring_tape"],
        completionEvidence: "",
        bin: { value: "A-14", source: "location_bin" },
        shipBy: { at: null, confidence: "unknown" },
      },
    ],
    groups: [],
    pullList: [{ bin: "A-14", label: "A-14", itemIds: ["item-1"] }],
    itemsRead: 1,
    truncated: false,
    ...over,
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

// The repo mounts with createRoot + act rather than testing-library, which is
// not a dependency here. Same coverage, one fewer package.
function renderPage(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client: qc },
        h(MemoryRouter, null, h(WorthMyTimePage)),
      ),
    );
  });
  return container;
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

async function typeCustom(value: string): Promise<void> {
  const input = document.getElementById("wmt-custom") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function text(): string {
  return container?.textContent ?? "";
}

function has(pattern: RegExp | string): boolean {
  const t = text();
  return typeof pattern === "string" ? t.includes(pattern) : pattern.test(t);
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

beforeEach(() => {
  buildMock.mockReset();
  savePrefsMock.mockReset();
  savePrefsMock.mockResolvedValue({});
  toastError.mockReset();
});

describe("the time picker (AC2)", () => {
  it("offers the presets and a custom field", () => {
    renderPage();
    for (const m of [15, 30, 60]) expect(buttonNamed(`${m} minutes`)).toBeTruthy();
    expect(document.getElementById("wmt-custom")).toBeTruthy();
    const label = Array.from(document.querySelectorAll("label"))
      .find((l) => l.getAttribute("for") === "wmt-custom");
    expect(label?.textContent).toBe("Or type it");
  });

  it("builds a plan for the chosen minutes", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    expect(buildMock).toHaveBeenCalled();
    expect(buildMock.mock.calls[0]![0]!.budgetMinutes).toBe(30);
    expect(buildMock.mock.calls[0]![0]!.workContext).toBe("home");
    expect(buildMock.mock.calls[0]![0]!.availableTools).toEqual([
      "camera",
      "measuring_tape",
    ]);
  });

  it("refuses a custom value outside the window, with the numbers", async () => {
    renderPage();
    await typeCustom("999");
    await click(/Plan it/);
    expect(buildMock).not.toHaveBeenCalled();
    expect(String(toastError.mock.calls[0]![0])).toContain("240");
  });

  it("remembers the choice, and a failure to remember is not a failure to plan", async () => {
    buildMock.mockResolvedValue(plan());
    savePrefsMock.mockRejectedValue(new Error("offline"));
    renderPage();
    await click("15 minutes");
    expect(has(/1 job/)).toBe(true);
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("what the plan says (AC3)", () => {
  it("headlines the TIME, never the money", async () => {
    // The single most tempting thing to put at the top of this screen is
    // "$48 in 30 minutes", and it would be a lie twice over: the value is a
    // conservative estimate against a sale that has not happened, and the
    // minutes are what the WORK takes.
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    const heading = document.getElementById("wmt-plan")!;
    expect(heading.textContent).toContain("about 11 minutes");
    expect(heading.textContent).not.toContain("$");
  });

  it("labels every value as an estimate rather than earnings", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    expect(has("Times and values are estimates, not earnings.")).toBe(true);
    expect(has(/worth about \$48\.00 after costs, if it sells/)).toBe(true);
  });

  it("never uses the word earn, and never promises money in a time", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    expect(has(/\bearn(?!ings)/i)).toBe(false);
    expect(has(/\$\d+ in \d+ minutes/)).toBe(false);
    expect(has(/guaranteed/i)).toBe(false);
  });

  it("shows the action, the item, the minutes, the bin and a plain reason", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    const row = Array.from(document.querySelectorAll("li"))
      .find((li) => li.textContent?.includes("Carhartt Detroit jacket"))!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Measure");
    expect(row.textContent).toContain("about 5 min");
    expect(row.textContent).toContain("A-14");
    expect(row.textContent).toContain("Closest to being ready to sell");
  });

  // US-3448: this asserts the SHAPE of the link, and it once passed against a
  // route that did not exist -- /dashboard/flipdesk/item/:id, when the router
  // has items/:id. A test comparing a literal to the literal the code writes
  // cannot tell an existing route from an invented one, whatever it is called.
  // The question is answered by src/test/no-dead-internal-links.test.ts, which
  // reads the router. This one is here for the row's wiring, not the path.
  it("links out to the EXISTING item route, not an invented one", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    const link = Array.from(document.querySelectorAll("a"))
      .find((a) => a.textContent?.includes("Open item"))!;
    expect(link.getAttribute("href")).toBe("/dashboard/flipdesk/items/item-1");
  });

  it("names the bins to bring over", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    expect(has("Bring these over")).toBe(true);
    expect(has(/A-14: 1 item/)).toBe(true);
  });
});

describe("the states a seller actually hits (AC5)", () => {
  const emptyPlan = (over: Record<string, unknown>) =>
    plan({
      plan: {
        tasks: [],
        plannedMinutes: 0,
        unusedMinutes: 5,
        omitted: [],
        conflicts: [],
        smallestEligibleMinutes: null,
        consideredCount: 0,
        version: 1,
        ...over,
      },
      pullList: [],
    });

  it("nothing fits: says how small the smallest job is", async () => {
    buildMock.mockResolvedValue(emptyPlan({ smallestEligibleMinutes: 11 }));
    renderPage();
    await click("15 minutes");
    expect(has(/shortest job waiting needs about 11 minutes/)).toBe(true);
  });

  it("no stock at all: says so rather than showing an empty list", async () => {
    buildMock.mockResolvedValue({
      ...emptyPlan({}),
      candidates: [],
      ranked: [],
    });
    renderPage();
    await click("30 minutes");
    expect(has(/no unfinished work in your stock/)).toBe(true);
  });

  it("an urgent deadline that will not fit proposes a longer window", async () => {
    buildMock.mockResolvedValue(emptyPlan({
      conflicts: [{
        key: "x:pack_ship",
        needsMinutes: 18,
        proposedBudgetMinutes: 20,
        message: "This parcel needs about 18 minutes and won't fit in 10.",
      }],
    }));
    renderPage();
    await click("15 minutes");
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("18 minutes");
    expect(alert.textContent).toContain("Try 20 minutes instead");
  });

  it("A FAILED REQUEST DOES NOT ERASE THE SAVED PLAN", async () => {
    // AC5's sharpest rule. A seller whose connection dropped mid-session must
    // not come back to a blank screen and assume the evening was lost.
    buildMock.mockResolvedValueOnce(plan());
    renderPage();
    await click("30 minutes");
    expect(has("Carhartt Detroit jacket")).toBe(true);

    buildMock.mockRejectedValueOnce(new Error("Network down"));
    await click("60 minutes");
    expect(toastError).toHaveBeenCalled();
    expect(has("Carhartt Detroit jacket")).toBe(true);
  });

  it("reports a truncated read rather than pretending it saw everything", async () => {
    buildMock.mockResolvedValue(plan({ truncated: true, itemsRead: 400 }));
    renderPage();
    await click("30 minutes");
    expect(has(/400 most recently updated items/)).toBe(true);
  });
});

describe("accessibility (AC6)", () => {
  it("every control has an accessible name", () => {
    renderPage();
    for (const el of Array.from(document.querySelectorAll("button"))) {
      const name = el.textContent?.trim() || el.getAttribute("aria-label") || "";
      expect(name.length).toBeGreaterThan(0);
    }
    for (const el of Array.from(document.querySelectorAll("input"))) {
      const labelled = el.getAttribute("aria-label") ||
        Array.from(document.querySelectorAll("label"))
          .some((l) => l.getAttribute("for") === el.id);
      expect(labelled, `input #${el.id} has no accessible name`).toBeTruthy();
    }
  });

  it("the sections carry headings a screen reader can jump to", () => {
    renderPage();
    const h1 = document.querySelector("h1")!;
    expect(h1.textContent).toBe("Worth My Time");
    const headings = Array.from(document.querySelectorAll("h2"))
      .map((el) => el.textContent);
    expect(headings).toContain("How long have you got?");
    // Each section is labelled BY its heading rather than by a duplicated
    // aria-label that can drift from the text on screen.
    const section = document.querySelector('[aria-labelledby="wmt-how-long"]');
    expect(section).toBeTruthy();
  });

  it("every preset is a real button, so keyboard and screen reader both reach it", () => {
    renderPage();
    for (const m of [15, 30, 60]) {
      const b = buttonNamed(`${m} minutes`);
      expect(b.tagName).toBe("BUTTON");
      expect(b.hasAttribute("disabled")).toBe(false);
    }
  });

  it("a conflict is announced, not only coloured", async () => {
    buildMock.mockResolvedValue(plan({
      plan: {
        tasks: [],
        plannedMinutes: 0,
        unusedMinutes: 10,
        omitted: [],
        conflicts: [{
          key: "x",
          needsMinutes: 18,
          proposedBudgetMinutes: 20,
          message: "Won't fit.",
        }],
        smallestEligibleMinutes: null,
        consideredCount: 1,
        version: 1,
      },
      pullList: [],
    }));
    renderPage();
    await click("15 minutes");
    expect(document.querySelector('[role="alert"]')).toBeTruthy();
  });
});
