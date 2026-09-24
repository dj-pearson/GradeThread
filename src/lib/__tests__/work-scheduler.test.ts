import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_CANDIDATES,
  proposeBudget,
  schedulePlan,
  SCHEDULER_VERSION,
  type ScheduleInput,
} from "@/lib/work-scheduler";
import { rankedDurationOf, type RankedTask } from "@/lib/work-ranker";
import type { CandidateAction } from "@/lib/work-candidates";
import { estimateDuration, isUnestimated } from "@/lib/work-duration";

// Worth My Time, R1 07/12 (US-3172).

const NOW = "2026-09-21T12:00:00Z";

function ranked(over: Partial<RankedTask> & { key: string; action: CandidateAction }): RankedTask {
  return {
    itemId: over.key.split(":")[0]!,
    tier: "valued_work",
    score: 100,
    chainMinutes: 10,
    conservativeCents: 1000,
    dueAt: null,
    prerequisiteKeys: [],
    conflict: null,
    meetsHourlyTarget: null,
    version: 1,
    // WMT-04: the scheduler reads the ranker's resolved duration.
    duration: rankedDurationOf(estimateDuration({ action: over.action })),
    ...over,
  } as RankedTask;
}

function plan(tasks: RankedTask[], over: Partial<ScheduleInput> = {}) {
  return schedulePlan({ now: NOW, budgetMinutes: 30, ranked: tasks, ...over });
}

/** The high-end minutes the scheduler plans on. */
function high(action: CandidateAction): number {
  const d = estimateDuration({ action });
  if (isUnestimated(d)) throw new Error(action);
  return d.high;
}

describe("it plans on the HIGH estimate (AC1)", () => {
  it("spends the budget at the high end, not the typical one", () => {
    // A plan built on typical minutes is right about half the time, and the
    // half it is wrong about is the half where the seller runs over -- which
    // is what turns a 30-minute list into another backlog.
    const p = plan([ranked({ key: "a:measure", action: "measure" })]);
    // measure is 3/5/9; setup for the measure family is 2.
    expect(p.tasks[0]!.activeMinutes).toBe(9);
    expect(p.tasks[0]!.overheadMinutes).toBe(2);
    expect(p.plannedMinutes).toBe(11);
    expect(p.unusedMinutes).toBe(19);
  });
});

describe("budgets across the whole range (AC5)", () => {
  const tasks = () => [
    ranked({ key: "a:draft_review", action: "draft_review" }),
    ranked({ key: "b:draft_review", action: "draft_review" }),
    ranked({ key: "c:photograph", action: "photograph" }),
    ranked({ key: "d:pack_ship", action: "pack_ship" }),
  ];

  it.each([5, 15, 30, 60, 240])("never overspends a %i minute budget", (budget) => {
    const p = plan(tasks(), { budgetMinutes: budget });
    expect(p.plannedMinutes).toBeLessThanOrEqual(budget);
    expect(p.unusedMinutes).toBe(budget - p.plannedMinutes);
    expect(p.unusedMinutes).toBeGreaterThanOrEqual(0);
  });

  it("a 5-minute budget fits the 5-minute screen task and says what it skipped", () => {
    const p = plan(tasks(), { budgetMinutes: 5 });
    // draft_review is 2/5/10 with no setup, so its high end of 10 does not fit
    // either. Nothing fits, and the empty state says how small the smallest is.
    expect(p.tasks).toHaveLength(0);
    expect(p.smallestEligibleMinutes).toBe(high("draft_review"));
    expect(p.omitted.every((o) => o.reason === "no_time_left")).toBe(true);
  });

  it("fills a 240-minute budget with everything available", () => {
    const p = plan(tasks(), { budgetMinutes: 240 });
    expect(p.tasks).toHaveLength(4);
    expect(p.omitted).toHaveLength(0);
  });
});

describe("setup is charged once per contiguous batch (AC1)", () => {
  it("three photos pay one lightbox", () => {
    const p = plan(
      ["a", "b", "c"].map((id) => ranked({ key: `${id}:photograph`, action: "photograph" })),
      { budgetMinutes: 240 },
    );
    expect(p.tasks.map((t) => t.overheadMinutes)).toEqual([6, 0, 0]);
    expect(p.plannedMinutes).toBe(6 + 3 * high("photograph"));
  });

  it("switching families pays the switch AND the new setup", () => {
    const p = plan(
      [
        ranked({ key: "a:photograph", action: "photograph" }),
        ranked({ key: "b:pack_ship", action: "pack_ship" }),
      ],
      { budgetMinutes: 240 },
    );
    expect(p.tasks[0]!.overheadMinutes).toBe(6);
    // 2 to switch, 4 to set up packing.
    expect(p.tasks[1]!.overheadMinutes).toBe(6);
  });

  it("start times are cumulative and never overlap", () => {
    const p = plan(
      ["a", "b", "c"].map((id) => ranked({ key: `${id}:photograph`, action: "photograph" })),
      { budgetMinutes: 240 },
    );
    expect(p.tasks.map((t) => t.startsAtMinute)).toEqual([0, 21, 36]);
  });
});

describe("an exact fit fits (AC5)", () => {
  it("a task costing exactly the remaining budget is taken", () => {
    // 2 setup + 9 active = 11.
    const p = plan([ranked({ key: "a:measure", action: "measure" })], {
      budgetMinutes: 11,
    });
    expect(p.tasks).toHaveLength(1);
    expect(p.unusedMinutes).toBe(0);
  });

  it("one minute short is omitted rather than squeezed", () => {
    const p = plan([ranked({ key: "a:measure", action: "measure" })], {
      budgetMinutes: 10,
    });
    expect(p.tasks).toHaveLength(0);
    expect(p.omitted[0]!.reason).toBe("no_time_left");
    expect(p.omitted[0]!.minutes).toBe(11);
  });
});

describe("a shipment that does not fit is a CONFLICT (AC3)", () => {
  it("returns the budget it would actually need", () => {
    const p = plan(
      [ranked({ key: "a:pack_ship", action: "pack_ship", tier: "urgent_shipping" })],
      { budgetMinutes: 10 },
    );
    expect(p.tasks).toHaveLength(0);
    expect(p.conflicts).toHaveLength(1);
    // 4 setup + 14 high = 18, proposed up to the next choosable 5.
    expect(p.conflicts[0]!.needsMinutes).toBe(18);
    expect(p.conflicts[0]!.proposedBudgetMinutes).toBe(20);
    expect(p.conflicts[0]!.message).toContain("18");
  });

  it("never truncates the estimate to claim it fits", () => {
    const p = plan(
      [ranked({ key: "a:pack_ship", action: "pack_ship", tier: "urgent_shipping" })],
      { budgetMinutes: 10 },
    );
    expect(p.plannedMinutes).toBe(0);
    expect(p.tasks.some((t) => t.activeMinutes < high("pack_ship"))).toBe(false);
  });

  it("non-urgent work that does not fit is omitted WITHOUT a conflict", () => {
    // A conflict is a promise the seller has made to somebody else. Prep work
    // that does not fit tonight is just work that does not fit tonight.
    const p = plan([ranked({ key: "a:photograph", action: "photograph" })], {
      budgetMinutes: 10,
    });
    expect(p.conflicts).toHaveLength(0);
    expect(p.omitted[0]!.reason).toBe("no_time_left");
  });

  it("proposeBudget rounds to something a seller can choose", () => {
    expect(proposeBudget(18)).toBe(20);
    expect(proposeBudget(20)).toBe(20);
    expect(proposeBudget(1)).toBe(5);
    expect(proposeBudget(9999)).toBe(240);
  });
});

describe("the empty state is useful (AC3)", () => {
  it("no tasks at all reports zero, not a crash", () => {
    const p = plan([]);
    expect(p.tasks).toHaveLength(0);
    expect(p.plannedMinutes).toBe(0);
    expect(p.unusedMinutes).toBe(30);
    expect(p.smallestEligibleMinutes).toBeNull();
  });

  it("nothing fits, so it says how small the smallest job is", () => {
    // "The smallest job here needs 12 minutes" is actionable. "Nothing to do"
    // is not, and it is also false.
    const p = plan(
      [
        ranked({ key: "a:photograph", action: "photograph" }),
        ranked({ key: "b:measure", action: "measure" }),
      ],
      { budgetMinutes: 5 },
    );
    expect(p.tasks).toHaveLength(0);
    // measure from a cold start: 2 setup + 9 = 11, against photograph's 21.
    expect(p.smallestEligibleMinutes).toBe(11);
  });

  it("a full plan reports NO smallest-eligible figure", () => {
    // A caller must not render "the smallest job needs 11 minutes" beside a
    // plan that already has four things in it.
    const p = plan([ranked({ key: "a:measure", action: "measure" })]);
    expect(p.tasks).toHaveLength(1);
    expect(p.smallestEligibleMinutes).toBeNull();
  });
});

describe("prerequisite order is preserved (AC2)", () => {
  it("a task whose prerequisite is not ready is omitted", () => {
    // Do not put a task before a photo upload or a grade result that has not
    // landed.
    const p = plan(
      [
        ranked({
          key: "a:draft_review",
          action: "draft_review",
          prerequisiteKeys: ["a:photograph"],
        }),
      ],
      { budgetMinutes: 240 },
    );
    expect(p.tasks).toHaveLength(0);
    expect(p.omitted[0]!.reason).toBe("prerequisite_not_ready");
  });

  it("a prerequisite satisfied outside the plan unblocks it", () => {
    const p = plan(
      [
        ranked({
          key: "a:draft_review",
          action: "draft_review",
          prerequisiteKeys: ["a:photograph"],
        }),
      ],
      { budgetMinutes: 240, satisfiedKeys: ["a:photograph"] },
    );
    expect(p.tasks).toHaveLength(1);
  });

  it("a chain is partly scheduled IN ORDER when each step fits", () => {
    const p = plan(
      [
        ranked({ key: "a:photograph", action: "photograph" }),
        ranked({
          key: "a:draft_review",
          action: "draft_review",
          prerequisiteKeys: ["a:photograph"],
        }),
      ],
      { budgetMinutes: 240 },
    );
    expect(p.tasks.map((t) => t.key)).toEqual(["a:photograph", "a:draft_review"]);
    expect(p.tasks[1]!.startsAtMinute).toBeGreaterThan(p.tasks[0]!.startsAtMinute);
  });

  it("a later step is NOT scheduled when its earlier step did not fit", () => {
    // Partly scheduling a chain is only allowed while each included step can
    // finish. Taking the draft without the photos would save no useful
    // progress -- the listing still cannot go live.
    const p = plan(
      [
        ranked({ key: "a:photograph", action: "photograph" }),
        ranked({
          key: "a:draft_review",
          action: "draft_review",
          prerequisiteKeys: ["a:photograph"],
        }),
      ],
      { budgetMinutes: 12 },
    );
    expect(p.tasks).toHaveLength(0);
    expect(p.omitted.map((o) => o.reason)).toEqual([
      "no_time_left",
      "prerequisite_not_ready",
    ]);
  });
});

describe("a task nobody has estimated (AC1)", () => {
  it("is omitted with a reason, never scheduled as free", () => {
    // Found by a sabotage that did not fire: every other fixture uses a real
    // action, so the unestimated branch was never entered. A task assumed to
    // cost nothing would be taken at any budget and would overfill the session
    // by however long it actually takes.
    const p = plan(
      [
        ranked({ key: "weird:reupholster", action: "reupholster" as CandidateAction }),
        ranked({ key: "a:measure", action: "measure" }),
      ],
      { budgetMinutes: 240 },
    );
    expect(p.tasks.map((t) => t.key)).toEqual(["a:measure"]);
    const skipped = p.omitted.find((o) => o.key === "weird:reupholster");
    expect(skipped?.reason).toBe("unestimated");
    expect(skipped?.minutes).toBeNull();
  });

  it("does not consume budget or set the batch family", () => {
    // The subtler half: an unestimated task that slipped through would also
    // become the `previousFamily`, so the NEXT task would skip its own setup.
    const withWeird = plan(
      [
        ranked({ key: "weird:reupholster", action: "reupholster" as CandidateAction }),
        ranked({ key: "a:photograph", action: "photograph" }),
      ],
      { budgetMinutes: 240 },
    );
    const without = plan([ranked({ key: "a:photograph", action: "photograph" })], {
      budgetMinutes: 240,
    });
    expect(withWeird.plannedMinutes).toBe(without.plannedMinutes);
    expect(withWeird.tasks[0]!.overheadMinutes).toBe(6);
  });
});

describe("it keeps walking after something does not fit", () => {
  it("a short task still fits in what a long one left behind", () => {
    // A seller with eight minutes spare would rather have a small job than a
    // rounding error.
    const p = plan(
      [
        ranked({ key: "big:photograph", action: "photograph" }),
        ranked({ key: "small:publish", action: "publish" }),
      ],
      { budgetMinutes: 12 },
    );
    expect(p.tasks.map((t) => t.key)).toEqual(["small:publish"]);
    expect(p.omitted[0]!.key).toBe("big:photograph");
  });
});

describe("bounded work on a large inventory (AC4)", () => {
  const thousand = Array.from({ length: 1000 }, (_, i) =>
    ranked({ key: `item-${String(i).padStart(4, "0")}:draft_review`, action: "draft_review" }));

  it("considers at most the candidate cap, whatever the inventory", () => {
    // ASSERTED AS AN OPERATION COUNT, not a wall-clock time (AC4). A timing
    // test fails on a loaded CI box and passes on a fast one, which tells you
    // about the box rather than the algorithm.
    const p = plan(thousand, { budgetMinutes: 240 });
    expect(p.consideredCount).toBe(MAX_CANDIDATES);
    expect(p.consideredCount).toBeLessThan(thousand.length);
  });

  it("the ones past the cap are reported, not silently gone", () => {
    const p = plan(thousand, { budgetMinutes: 240 });
    const capped = p.omitted.filter((o) => o.reason === "beyond_candidate_cap");
    expect(capped).toHaveLength(1000 - MAX_CANDIDATES);
  });

  it("truncation keeps the BEST-ranked work, because it happens after ranking", () => {
    const p = plan(thousand, { budgetMinutes: 240 });
    // The first task planned is the first task ranked.
    expect(p.tasks[0]!.key).toBe("item-0000:draft_review");
  });

  it("does no subset search: the result is one pass in ranked order", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-scheduler.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    // A knapsack would pack tighter and would reorder the seller's most
    // important work to do it, which is the opposite of what the ranker chose.
    expect(code).not.toMatch(/knapsack|permut|backtrack|\.sort\(/);
    // Exactly one loop over the candidates.
    expect((code.match(/for \(const task of considered\)/g) ?? [])).toHaveLength(1);
  });
});

describe("determinism (AC1)", () => {
  it("the same input plans the same way twice", () => {
    const tasks = [
      ranked({ key: "a:measure", action: "measure" }),
      ranked({ key: "b:photograph", action: "photograph" }),
    ];
    expect(plan(tasks)).toEqual(plan(tasks));
  });

  it("reads no clock: `now` is an argument", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-scheduler.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    for (const banned of ["Date.now", "new Date(", "Math.random", "fetch("]) {
      expect(code.includes(banned), `work-scheduler.ts uses ${banned}`).toBe(false);
    }
  });

  it("stamps the scheduler version", () => {
    expect(plan([]).version).toBe(SCHEDULER_VERSION);
  });
});

describe("the budget is clamped to the preferences window", () => {
  it("refuses to plan outside 5 to 240 minutes", () => {
    expect(plan([], { budgetMinutes: 1 }).unusedMinutes).toBe(5);
    expect(plan([], { budgetMinutes: 9999 }).unusedMinutes).toBe(240);
    expect(plan([], { budgetMinutes: -30 }).unusedMinutes).toBe(5);
  });
});
