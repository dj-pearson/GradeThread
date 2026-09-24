import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Worth My Time, R1 10/12 (US-3175).
//
// The pipeline under this page is already driven by its own suites, so what
// these cases hold is the SCREEN: what it says, what it refuses to say, and
// what it does when a request fails.

const PREFS = {
  defaultSessionMinutes: 30,
  workContext: "home",
  availableTools: ["camera", "measuring_tape"],
  hourlyTargetAmount: null,
  hourlyTargetSet: false,
  sessionMinutePresets: [15, 30, 60],
  minSessionMinutes: 5,
  maxSessionMinutes: 240,
  workTools: [],
};
let prefsOver: Record<string, unknown> = {};
const buildMock = vi.fn();
const savePrefsMock = vi.fn(() => Promise.resolve({}));
const startSessionMock = vi.fn(() => Promise.resolve({}));
const toastError = vi.fn();

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("@/hooks/use-planner", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/hooks/use-planner");
  return {
    ...actual,
    useWorkPreferences: () => ({
      data: { ...PREFS, ...prefsOver },
      isError: false,
      isSuccess: true,
    }),
    useSaveWorkPreferences: () => ({ mutateAsync: savePrefsMock }),
    useBuildPlan: () => ({ mutateAsync: buildMock, isPending: false }),
    // US-3176 put a session runner at the top of this page. These cases are
    // about the PICKER and the PLAN, so the runner is held at "no session" --
    // its own behaviour has its own suite (session-runner.test.tsx) rather
    // than being re-asserted through every case here.
    useCurrentSession: () => ({
      data: { session: null, tasks: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useStartSession: () => ({ mutateAsync: startSessionMock, isPending: false }),
    // US-3182. The correction panel has its own suite; here it is held at
    // "nothing corrected" so these cases keep testing the plan.
    useWorkOverrides: () => ({
      data: { overrides: [], suppressions: [], now: "2026-09-21T11:00:00.000Z" },
      refetch: () =>
        Promise.resolve({
          data: { overrides: [], suppressions: [], now: "2026-09-21T11:00:00.000Z" },
        }),
    }),
    useLearnedDurations: () => ({ data: undefined }),
    // US-3183. The results panel has its own suite; held at "no history" here
    // so these cases stay about the plan. Left unmocked it renders its own
    // role="alert" and steals the one these cases look for.
    useWorkOutcomes: () => ({
      data: { outcomes: [], tasks: [], now: "2026-09-21T11:00:00.000Z" },
      isLoading: false,
      isError: false,
    }),
    useSaveOverride: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useResetOverride: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSuppress: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useResetSuppression: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
        // WMT-04: the ranker's resolved duration, which every surface reads.
        duration: {
          low: 3, typical: 5, high: 9, family: "measure", setupMinutes: 2,
          unattendedMinutes: 0, source: "default", version: 1, sampleCount: null,
        },
        conservativeCents: 4800,
        // WMT-05: the value snapshot the ranker ranked on.
        value: {
          complete: true, wholeItemProfitCents: 5000, remainingContributionCents: 6000,
          lowCents: 4800, highCents: 7200, evidence: "seller_estimate",
          observedAt: "2026-09-20T00:00:00.000Z", missing: [], horizonDays: 30,
        },
        valueSource: "seller_estimate",
        valueFromOverride: false,
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
    budgetMinutes: 30,
    takenAt: "2026-09-21T11:00:00.000Z",
    // US-3182: the corrections the plan was built with, and what they hid.
    suppressed: [],
    book: { overrides: [], suppressions: [], now: "2026-09-21T11:00:00.000Z" },
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
  prefsOver = {};
  buildMock.mockReset();
  savePrefsMock.mockReset();
  savePrefsMock.mockResolvedValue({});
  toastError.mockReset();
  startSessionMock.mockReset();
  startSessionMock.mockResolvedValue({});
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

describe("why this task (US-3181)", () => {
  it("every row can be opened, and it is a native disclosure", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    const details = Array.from(document.querySelectorAll("details"))
      .find((d) => d.textContent?.includes("Why this one?"))!;
    expect(details).toBeTruthy();
    // A <details> is keyboard-operable and screen-reader-announced with no
    // handler of ours. A div with onClick would need both written and tested.
    expect(details.tagName).toBe("DETAILS");
    expect(details.querySelector("summary")?.textContent).toBe("Why this one?");
  });

  it("the primary row stays short: the detail is closed until asked for", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    const details = Array.from(document.querySelectorAll("details"))
      .find((d) => d.textContent?.includes("Why this one?"))!;
    expect(details.hasAttribute("open")).toBe(false);
  });

  it("states where the minutes and the value came from", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    const t = text();
    expect(t).toContain("Left on this item");
    // The R1 default is a guess and says so, rather than reading as measured.
    expect(t).toContain("starting guess");
  });

  it("WMT-05: shows the Worth range from the snapshot, not a rebuilt value", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    expect(text()).toContain("Worth: $48.00 to $72.00, if it sells");
    expect(text()).toContain("The value is the price you typed.");
  });

  it("shows NO confidence percentage anywhere", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    // There is no calibrated source for one, and a number invented from a
    // sort key would be the most believable wrong thing on the screen.
    expect(text()).not.toMatch(/\d+\s*% (sure|confident|likely)/i);
    expect(text()).not.toMatch(/confidence/i);
  });

  it("renders item text as TEXT, never as markup", async () => {
    const p = plan();
    (p.candidates[0] as { itemTitle: string }).itemTitle =
      '<img src=x onerror="alert(1)">Carhartt';
    buildMock.mockResolvedValue(p);
    renderPage();
    await click("30 minutes");
    // The string is visible as characters and produced no element.
    expect(text()).toContain("<img src=x");
    expect(container?.querySelector("img")).toBeNull();
  });

  it("the page never reaches for dangerouslySetInnerHTML", () => {
    // COMMENTS STRIPPED FIRST. The page carries a comment saying it does not
    // use this, so a naive scan finds the banned name inside the sentence
    // forbidding it and fails on correct code -- which is exactly what
    // happened on the first run. Block comments go as BLOCKS, because
    // dropping lines that start with // leaves the opening /** in place.
    const raw = readFileSync(
      resolve(process.cwd(), "src/pages/flipdesk/worth-my-time.tsx"),
      "utf8",
    );
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toContain("dangerouslySetInnerHTML");
    // Guards the guard: the stripper must not have eaten the file.
    expect(code).toContain("export function WorthMyTimePage");
  });

  it("says why a job did not make the list", async () => {
    const p = plan();
    (p.plan as { omitted: unknown[] }).omitted = [
      { key: "item-9:photograph", reason: "no_time_left", minutes: 14 },
    ];
    (p.candidates as unknown[]).push({
      key: "item-9:photograph",
      itemId: "item-9",
      itemTitle: "Levi 501 jeans",
      action: "photograph",
      prerequisiteKeys: [],
      requiredContext: ["home"],
      requiredTools: ["camera"],
      completionEvidence: "",
      bin: { value: null, source: "none" },
      shipBy: { at: null, confidence: "unknown" },
    });
    buildMock.mockResolvedValue(p);
    renderPage();
    await click("30 minutes");
    expect(has("didn't make the list")).toBe(true);
    expect(has("Levi 501 jeans")).toBe(true);
    expect(has("It didn't fit the time you had.")).toBe(true);
    expect(has("about 14 min")).toBe(true);
  });

  it("says nothing about omissions when there are none", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    expect(has("didn't make the list")).toBe(false);
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
    // WMT-04: what the plan CHARGED, with the setup it paid, so the rows add
    // up to the headline.
    expect(row.textContent).toContain("about 9 min +2 to set up");
    expect(row.textContent).toContain("A-14");
    expect(row.textContent).toContain("Closest to being ready to sell");
  });

  it("WMT-04: the rows plus their setup add up to the headline", async () => {
    buildMock.mockResolvedValue(plan({
      plan: {
        ...plan().plan,
        tasks: [
          { key: "item-1:measure", itemId: "item-1", family: "measure", activeMinutes: 9, overheadMinutes: 2, startsAtMinute: 0 },
          { key: "item-2:measure", itemId: "item-2", family: "measure", activeMinutes: 9, overheadMinutes: 0, startsAtMinute: 11 },
        ],
        plannedMinutes: 20,
      },
    }));
    renderPage();
    await click("30 minutes");
    const rows = Array.from(document.querySelectorAll("ol > li"));
    const sum = rows.reduce((s, li) => {
      const t = li.textContent ?? "";
      const m = /about (\d+) min(?: \+(\d+) to set up)?/.exec(t);
      return s + Number(m?.[1] ?? 0) + Number(m?.[2] ?? 0);
    }, 0);
    expect(sum).toBe(20);
    expect(document.getElementById("wmt-plan")!.textContent).toContain("about 20 minutes");
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
    const href = link.getAttribute("href")!;
    expect(href.split("?")[0]).toBe("/dashboard/flipdesk/items/item-1");
    // US-3176: and it carries where to come back to, so a seller who opens
    // the item mid-session is not dropped on the inventory list afterwards.
    expect(new URLSearchParams(href.split("?")[1]).get("back"))
      .toBe("/dashboard/flipdesk/worth-my-time");
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

describe("the setup, edited where the plan is (WMT-06)", () => {
  it("says how many jobs a missing tool holds back, and one tap adds it", async () => {
    prefsOver = { availableTools: ["camera"] };
    buildMock.mockResolvedValue(plan({
      gated: [
        { itemId: "a", action: "measure", reason: "tools", missing: ["measuring_tape"] },
        { itemId: "b", action: "measure", reason: "tools", missing: ["measuring_tape"] },
      ],
    }));
    renderPage();
    await click("30 minutes");
    savePrefsMock.mockClear();
    expect(has("2 jobs need a tape measure.")).toBe(true);
    await click("I have one");
    // ONE patch, naming only the tools.
    expect(savePrefsMock).toHaveBeenCalledTimes(1);
    expect(savePrefsMock.mock.calls[0]).toEqual([
      { available_tools: ["camera", "measuring_tape"] },
    ]);
    expect(has("You changed something since this plan was built")).toBe(true);
  });

  it("a tool chip sends only available_tools and marks the plan stale", async () => {
    buildMock.mockResolvedValue(plan());
    renderPage();
    await click("30 minutes");
    savePrefsMock.mockClear();
    const chip = buttonNamed("Steamer");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    await click("Steamer");
    expect(savePrefsMock.mock.calls).toEqual([
      [{ available_tools: ["camera", "measuring_tape", "steamer"] }],
    ]);
    expect(has("You changed something since this plan was built")).toBe(true);
  });

  it("no longer sends the seller to the inventory screen to change it", () => {
    renderPage();
    const link = Array.from(document.querySelectorAll("a"))
      .find((a) => a.textContent?.includes("Change your setup"));
    expect(link).toBeUndefined();
    expect(document.getElementById("wmt-setup")).not.toBeNull();
  });
});
