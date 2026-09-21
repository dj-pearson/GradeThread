import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  batchMinutes,
  CONTEXT_SWITCH_MINUTES,
  DURATION_MODEL_VERSION,
  estimateDuration,
  isUnestimated,
  setupCostFor,
  switchCost,
  TASK_FAMILIES,
  UNATTENDED_WAITS,
  waitFor,
  type DurationEstimate,
} from "@/lib/work-duration";
import { CANDIDATE_ACTIONS } from "@/lib/work-candidates";

// Worth My Time, R1 04/12 (US-3169).

function estimate(action: string): DurationEstimate {
  const r = estimateDuration({ action });
  if (isUnestimated(r)) throw new Error(`unexpectedly unestimated: ${action}`);
  return r;
}

describe("every supported candidate has a real estimate (AC1)", () => {
  it("covers every action the candidate builder can produce", () => {
    // The coupling that matters: a new action in R1 03/12 with no duration
    // here would reach the planner as a task of unknown length.
    for (const action of CANDIDATE_ACTIONS) {
      const r = estimateDuration({ action });
      expect(isUnestimated(r), `${action} has no estimate`).toBe(false);
    }
  });

  it("every estimate is positive, finite and ordered", () => {
    for (const action of CANDIDATE_ACTIONS) {
      const e = estimate(action);
      for (const n of [e.low, e.typical, e.high]) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThan(0);
      }
      expect(e.low).toBeLessThanOrEqual(e.typical);
      expect(e.typical).toBeLessThanOrEqual(e.high);
      expect(TASK_FAMILIES).toContain(e.family);
      expect(e.version).toBe(DURATION_MODEL_VERSION);
    }
  });

  it("unsupported work is UNESTIMATED, never zero minutes", () => {
    // A zero would make an unknown task look free and sort it to the front of
    // every plan, which is the worst place for the one task nobody understands.
    const r = estimateDuration({ action: "reupholster" });
    expect(isUnestimated(r)).toBe(true);
    if (isUnestimated(r)) expect(r.reason).toContain("reupholster");
  });
});

describe("these are assumptions, and they say so (AC2)", () => {
  it("every default reports source `default`, never `seller`", () => {
    // Nobody has timed a seller doing any of this with the app in front of
    // them. Until R2 01/06 measures it, no surface may present a guess as a
    // finding, and this field is how a surface can tell.
    for (const action of CANDIDATE_ACTIONS) {
      expect(estimate(action).source).toBe("default");
    }
  });
});

describe("independence from the time-saved meter (AC2)", () => {
  it("does not import the time-saved numbers", () => {
    // They are a DIFFERENT quantity: hypothetical manual time avoided by
    // automation, contracted to the vault and pinned three ways. Sharing them
    // would mean the marketing claim and the plan could never move apart.
    const src = readFileSync(
      resolve(process.cwd(), "src/lib/work-duration.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from ["']@\/lib\/time-saved["']/);
    expect(src).not.toMatch(/TIME_SAVED_MINUTES/);
  });

  it("is free to disagree with them, and does", () => {
    // The check that the separation is real rather than declared: the
    // time-saved meter says measurements save 4 minutes; the planner says
    // measuring takes 5 typical. Both can be right, and neither may move the
    // other.
    const saved = readFileSync(
      resolve(process.cwd(), "src/lib/time-saved.ts"),
      "utf8",
    );
    expect(saved).toMatch(/measurements: 4/);
    expect(estimate("measure").typical).toBe(5);
  });
});

describe("waiting is not work (AC3)", () => {
  it("no task carries unattended minutes in its active estimate", () => {
    // A grading job takes ten seconds to start and then runs without the
    // seller. Only the ten seconds belongs in a time budget.
    for (const action of CANDIDATE_ACTIONS) {
      expect(estimate(action).unattendedMinutes).toBe(0);
    }
  });

  it("a waiting result NEVER blocks the session", () => {
    // The rule this whole criterion exists for. A plan that blocked on a
    // grading job would have the seller sit watching a spinner while four
    // other items are ready to work on.
    for (const kind of Object.keys(UNATTENDED_WAITS) as (keyof typeof UNATTENDED_WAITS)[]) {
      const w = waitFor(kind);
      expect(w.blocksSession).toBe(false);
      expect(w.minutes).toBeGreaterThan(0);
    }
  });
});

describe("setup is charged once per batch (AC4)", () => {
  it("the first task of a family pays, the rest do not", () => {
    expect(setupCostFor("photo", null)).toBe(6);
    expect(setupCostFor("photo", "photo")).toBe(0);
    expect(setupCostFor("photo", "measure")).toBe(6);
  });

  it("screen work costs nothing to set up", () => {
    // A plan that charged setup for opening a browser tab would push every
    // short screen task below the bar and tell the seller a five-minute job
    // takes eight.
    expect(setupCostFor("screen", null)).toBe(0);
    expect(setupCostFor("screen", "pack")).toBe(0);
  });

  it("eight photos cost one lightbox, not eight", () => {
    // The arithmetic that makes "you have 30 minutes, here is what fits" true.
    const one = batchMinutes([{ family: "photo", typical: 8 }]);
    const eight = batchMinutes(
      Array.from({ length: 8 }, () => ({ family: "photo" as const, typical: 8 })),
    );
    expect(one).toBe(6 + 8);
    expect(eight).toBe(6 + 8 * 8);
    // Charging setup per item would be 8 * (6 + 8) = 112, which is 42 minutes
    // more: the difference between a plan that fits an evening and one that
    // does not.
    expect(eight).toBeLessThan(8 * (6 + 8));
  });

  it("switching families costs the switch AND the new setup", () => {
    expect(switchCost(null, "photo")).toBe(0);
    expect(switchCost("photo", "photo")).toBe(0);
    expect(switchCost("photo", "pack")).toBe(CONTEXT_SWITCH_MINUTES);

    const mixed = batchMinutes([
      { family: "photo", typical: 8 },
      { family: "photo", typical: 8 },
      { family: "pack", typical: 7 },
    ]);
    // 6 setup + 8 + 8, then 2 to switch + 4 setup + 7.
    expect(mixed).toBe(6 + 8 + 8 + 2 + 4 + 7);
  });

  it("an empty batch costs nothing", () => {
    expect(batchMinutes([])).toBe(0);
  });
});

describe("bad input is refused, not clamped (AC5)", () => {
  it("a nonfinite or negative override is unestimated", () => {
    // Clamping would let a corrupt stored value quietly become a plausible
    // number, and the seller would never learn their override was junk.
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
      const r = estimateDuration({ action: "measure", overrideTypicalMinutes: bad });
      expect(isUnestimated(r), `${String(bad)} should be refused`).toBe(true);
    }
  });

  it("an absent override falls back to the default, not to zero", () => {
    for (const absent of [undefined, null]) {
      const r = estimateDuration({ action: "measure", overrideTypicalMinutes: absent });
      expect(isUnestimated(r)).toBe(false);
      if (!isUnestimated(r)) expect(r.source).toBe("default");
    }
  });

  it("a valid override rebuilds the spread and is marked as the seller's", () => {
    // A single number pretending to be certain is worse than a range. The
    // default's proportions are kept so the shape of the uncertainty survives.
    const r = estimateDuration({ action: "photograph", overrideTypicalMinutes: 12 });
    expect(isUnestimated(r)).toBe(false);
    if (isUnestimated(r)) return;
    expect(r.typical).toBe(12);
    expect(r.low).toBeLessThan(12);
    expect(r.high).toBeGreaterThan(12);
    expect(r.source).toBe("seller");
  });

  it("a tiny override still produces a positive low bound", () => {
    // 1 minute against photograph's 4/8/15 ratios rounds the low to 0, and a
    // zero-minute task sorts to the front of every plan.
    const r = estimateDuration({ action: "photograph", overrideTypicalMinutes: 1 });
    expect(isUnestimated(r)).toBe(false);
    if (isUnestimated(r)) return;
    expect(r.low).toBeGreaterThan(0);
    expect(r.high).toBeGreaterThan(0);
  });
});

describe("determinism (AC5)", () => {
  it("the same input gives the same answer every time", () => {
    // A plan a seller re-opened and found different is a plan they stop
    // trusting.
    for (const action of CANDIDATE_ACTIONS) {
      expect(estimateDuration({ action })).toEqual(estimateDuration({ action }));
    }
    expect(batchMinutes([{ family: "photo", typical: 8 }]))
      .toBe(batchMinutes([{ family: "photo", typical: 8 }]));
  });

  it("reads no clock, no random and no environment", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/lib/work-duration.ts"),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    for (const banned of ["Date.now", "Math.random", "new Date", "process.env", "import.meta.env"]) {
      expect(code.includes(banned), `work-duration.ts uses ${banned}`).toBe(false);
    }
  });
});

describe("the learned source is R2, not now (AC5)", () => {
  it("nothing here reads a seller's history", () => {
    // R2 01/06 adds the learned duration. The override parameter is the seam
    // it will use; there is no lookup, no store and no query behind it yet,
    // and a caller cannot get `seller` without passing one.
    const src = readFileSync(
      resolve(process.cwd(), "src/lib/work-duration.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/supabase|fetch\(|useQuery/);
    expect(estimate("measure").source).toBe("default");
  });
});
