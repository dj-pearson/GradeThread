// US-3178: what the estimator is allowed to learn, and what it must refuse.
//
// AC5 names nine cases and every one of them is a way to learn something
// false: four samples versus five, the latest-20 window, an extreme sample, a
// correction, a pause, batch attribution, two contexts, two owners, and the
// marketing counter. They are each their own describe block below, so a
// failure names which rule broke rather than "learning is wrong".

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LEARNING_WINDOW,
  MAX_VALID_MINUTES,
  MIN_SAMPLES,
  allocate,
  learnDurations,
  learnedFor,
  learnedSetupFor,
  poolKey,
  validObservations,
  type RawObservation,
} from "@/lib/work-duration-learning";
import { estimateDuration, isUnestimated } from "@/lib/work-duration";

let seq = 0;

function obs(over: Partial<RawObservation> = {}): RawObservation {
  seq += 1;
  return {
    taskId: `t${seq}`,
    sessionId: "s1",
    position: seq,
    family: "photo",
    context: "home",
    taskState: "completed",
    sessionState: "completed",
    confirmedMinutes: 8,
    correctionMinutes: null,
    endedAt: "2026-09-20T10:00:00.000Z",
    ...over,
  };
}

/** N solo photo tasks, each in its own session, so none of them batch. */
function solos(minutes: number[], over: Partial<RawObservation> = {}): RawObservation[] {
  return minutes.map((m, i) =>
    obs({
      sessionId: `solo-${i}-${over.context ?? "home"}`,
      position: 1,
      confirmedMinutes: m,
      ...over,
    })
  );
}

describe("four samples versus five (AC1, AC5)", () => {
  it("four is not enough: the labeled default still stands", () => {
    const r = learnDurations(solos([7, 8, 9, 10]));
    expect(learnedFor(r, "photo", "home")).toBeNull();
    const pool = r.pools.find((p) => p.key === poolKey("photo", "home", "solo"))!;
    expect(pool.sampleCount).toBe(4);
    // REPORTED, NOT SILENT. A seller four jobs in has a pool; it just has not
    // cleared the floor, and a diagnostic has to be able to say so.
    expect(pool.learned).toBe(false);
  });

  it("five is enough, and the floor is the constant rather than a literal", () => {
    expect(MIN_SAMPLES).toBe(5);
    const r = learnDurations(solos([7, 8, 9, 10, 11]));
    const learned = learnedFor(r, "photo", "home")!;
    expect(learned.typicalMinutes).toBe(9);
    expect(learned.sampleCount).toBe(5);
    expect(learned.observedLowMinutes).toBe(7);
    expect(learned.observedHighMinutes).toBe(11);
  });
});

describe("the latest-20 window (AC1, AC5)", () => {
  it("takes the twenty most recent and ignores older ones", () => {
    // Twenty-five sessions. The five OLDEST are 60 minutes; if they reached
    // the median it would be well above 5.
    const old = Array.from({ length: 5 }, (_, i) =>
      obs({
        sessionId: `old-${i}`,
        position: 1,
        confirmedMinutes: 60,
        endedAt: `2026-01-0${i + 1}T10:00:00.000Z`,
      }));
    const recent = Array.from({ length: LEARNING_WINDOW }, (_, i) =>
      obs({
        sessionId: `new-${i}`,
        position: 1,
        confirmedMinutes: 5,
        endedAt: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
      }));
    const r = learnDurations([...old, ...recent]);
    const learned = learnedFor(r, "photo", "home")!;
    expect(learned.sampleCount).toBe(LEARNING_WINDOW);
    expect(learned.typicalMinutes).toBe(5);
    // And the range is the window's, not the whole history's.
    expect(learned.observedHighMinutes).toBe(5);
  });

  it("a row with no end time sorts last rather than displacing a dated one", () => {
    const dated = Array.from({ length: LEARNING_WINDOW }, (_, i) =>
      obs({
        sessionId: `d-${i}`,
        position: 1,
        confirmedMinutes: 5,
        endedAt: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
      }));
    const undated = obs({ sessionId: "u", position: 1, confirmedMinutes: 99, endedAt: null });
    const r = learnDurations([undated, ...dated]);
    expect(learnedFor(r, "photo", "home")!.observedHighMinutes).toBe(5);
  });
});

describe("extreme samples (AC2, AC5)", () => {
  it("one interrupted afternoon does not move the median", () => {
    // A MEAN would move from 8 to 14.4 and stay there. This is the whole
    // reason AC1 names the median.
    const r = learnDurations(solos([7, 8, 8, 9, 40]));
    expect(learnedFor(r, "photo", "home")!.typicalMinutes).toBe(8);
  });

  it("refuses a duration longer than a whole session, rather than clamping", () => {
    const r = learnDurations(solos([7, 8, 9, 10, MAX_VALID_MINUTES + 1]));
    const learned = learnedFor(r, "photo", "home");
    // Four valid samples left: below the floor, so nothing is learned.
    expect(learned).toBeNull();
    expect(r.rejected.map((x) => x.reason)).toContain("above_bound");
  });

  it("refuses zero, negative and nonfinite minutes, each for its own reason", () => {
    const r = learnDurations([
      obs({ taskId: "z", confirmedMinutes: 0 }),
      obs({ taskId: "n", confirmedMinutes: -4 }),
      obs({ taskId: "i", confirmedMinutes: Number.POSITIVE_INFINITY }),
      obs({ taskId: "a", confirmedMinutes: Number.NaN }),
    ]);
    const byId = Object.fromEntries(r.rejected.map((x) => [x.taskId, x.reason]));
    expect(byId.z).toBe("nonpositive");
    expect(byId.n).toBe("nonpositive");
    // Infinity is caught by the FINITENESS check, not the bound: the order in
    // validObservations is finite, then positive, then bound, and Infinity
    // fails the first. The reason a caller reads is the first rule it broke,
    // which is the useful one.
    expect(byId.i).toBe("nonfinite");
    expect(byId.a).toBe("nonfinite");
  });

  it("the bound is tied to the session limit, not picked", () => {
    // MAX_BUDGET_MINUTES in the planner router. A single task claiming more
    // than a whole session did not happen the way it was recorded.
    expect(MAX_VALID_MINUTES).toBe(240);
  });
});

describe("corrections (AC2, AC5)", () => {
  it("a correction beats the confirmation it replaces", () => {
    const r = learnDurations(
      solos([9, 9, 9, 9, 9]).map((o, i) =>
        i === 0 ? { ...o, correctionMinutes: 3 } : o
      ),
    );
    // 3, 9, 9, 9, 9 -> median 9, and the range shows the correction landed.
    expect(learnedFor(r, "photo", "home")!.observedLowMinutes).toBe(3);
  });

  it("a correction of zero is still refused, not preferred", () => {
    const rows = solos([9, 9, 9, 9, 9]).map((o, i) =>
      i === 0 ? { ...o, correctionMinutes: 0 } : o
    );
    const r = learnDurations(rows);
    expect(r.rejected[0]?.reason).toBe("nonpositive");
    expect(learnedFor(r, "photo", "home")).toBeNull();
  });
});

describe("pauses and unconfirmed work (AC2, AC5)", () => {
  it("a task finished without an answer teaches nothing", () => {
    // NOT a fallback to the clock. The observed column exists and is
    // deliberately not read here: it is what a paused tab measured.
    const r = learnDurations([
      ...solos([8, 8, 8, 8]),
      obs({ sessionId: "x", position: 1, confirmedMinutes: null }),
    ]);
    expect(r.rejected.map((x) => x.reason)).toContain("unconfirmed");
    expect(learnedFor(r, "photo", "home")).toBeNull();
  });

  it("skipped, invalidated and pending tasks are all excluded", () => {
    const r = learnDurations([
      obs({ taskId: "s", taskState: "skipped", confirmedMinutes: 3 }),
      obs({ taskId: "i", taskState: "invalidated", confirmedMinutes: 3 }),
      obs({ taskId: "p", taskState: "pending", confirmedMinutes: 3 }),
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "not_completed", "not_completed", "not_completed",
    ]);
  });

  it("an abandoned session is not believed even where its tasks say completed", () => {
    // Abandoning is what a seller does when they walk away, and the last task
    // before they did is the one most likely to be mistimed.
    const r = learnDurations(
      solos([8, 8, 8, 8, 8]).map((o) => ({ ...o, sessionState: "abandoned" })),
    );
    expect(r.rejected.every((x) => x.reason === "session_not_completed")).toBe(true);
    expect(learnedFor(r, "photo", "home")).toBeNull();
  });
});

describe("batch attribution (AC3, AC5)", () => {
  const run = (minutes: number[], sessionId: string): RawObservation[] =>
    minutes.map((m, i) =>
      obs({ sessionId, position: i + 1, confirmedMinutes: m, endedAt: `2026-09-${String(minutes.length + i + 1).padStart(2, "0")}T10:00:00.000Z` })
    );

  it("one four-item batch is not four independent per-item samples", () => {
    // THE CASE AC3 NAMES. 12, 4, 5, 4 -- the 12 is the lightbox coming out.
    const allocated = allocate(validObservations(run([12, 4, 5, 4], "b1")).kept);
    expect(allocated.map((a) => a.allocation))
      .toEqual(["batch_first", "per_item", "per_item", "per_item"]);
    // Three per-item samples out of four tasks, which is the honest count.
    expect(allocated.filter((a) => a.allocation === "per_item")).toHaveLength(3);
  });

  it("the per-item median ignores the setup-bearing first task", () => {
    const r = learnDurations([
      ...run([12, 4, 5, 4], "b1"),
      ...run([11, 4, 6, 4], "b2"),
    ]);
    // Six per-item samples: 4,5,4,4,6,4 -> median 4. A flat median over all
    // eight numbers would be 4.5 and would keep drifting up with every batch.
    const learned = learnedFor(r, "photo", "home")!;
    expect(learned.allocation).toBe("per_item");
    expect(learned.sampleCount).toBe(6);
    expect(learned.typicalMinutes).toBe(4);
  });

  it("a run of one is solo, a different quantity, counted separately", () => {
    const r = learnDurations(solos([9, 9, 9, 9, 9]));
    expect(r.pools.map((p) => p.allocation)).toEqual(["solo"]);
    expect(learnedFor(r, "photo", "home")!.allocation).toBe("solo");
  });

  it("a gap in positions breaks a run even when the family matches", () => {
    // The seller did something else in between and put the lightbox down.
    const allocated = allocate([
      obs({ sessionId: "g", position: 1, confirmedMinutes: 10 }),
      obs({ sessionId: "g", position: 3, confirmedMinutes: 10 }),
    ]);
    expect(allocated.map((a) => a.allocation)).toEqual(["solo", "solo"]);
  });

  it("a different family breaks a run", () => {
    const allocated = allocate([
      obs({ sessionId: "f", position: 1, family: "photo", confirmedMinutes: 10 }),
      obs({ sessionId: "f", position: 2, family: "measure", confirmedMinutes: 5 }),
      obs({ sessionId: "f", position: 3, family: "measure", confirmedMinutes: 5 }),
    ]);
    expect(allocated.map((a) => `${a.family}:${a.allocation}`))
      .toEqual(["photo:solo", "measure:batch_first", "measure:per_item"]);
  });

  it("setup is learned as the difference, and only when both pools are real", () => {
    const r = learnDurations([
      ...run([12, 4, 5, 4], "b1"),
      ...run([11, 4, 6, 4], "b2"),
      ...run([12, 4, 4, 4], "b3"),
      ...run([12, 4, 4, 4], "b4"),
      ...run([12, 4, 4, 4], "b5"),
    ]);
    const setup = learnedSetupFor(r, "photo", "home")!;
    // first median 12, per-item median 4 -> 8 minutes of setup.
    expect(setup.setupMinutes).toBe(8);
    expect(setup.sampleCount).toBe(5);
  });

  it("no setup figure when only one of the two pools cleared the floor", () => {
    // A difference between a measured number and a guessed one is not a
    // measurement.
    const r = learnDurations([...run([12, 4, 5, 4], "b1")]);
    expect(learnedSetupFor(r, "photo", "home")).toBeNull();
  });

  it("refuses a negative setup rather than flooring it at zero", () => {
    // A first task faster than the rest means the run was not what this model
    // thinks it was, and reporting zero would hide that.
    const fast = [1, 2, 3, 4, 5].map((i) =>
      obs({ sessionId: `n${i}`, position: 1, confirmedMinutes: 2 })
    );
    const rest = [1, 2, 3, 4, 5].flatMap((i) => [
      obs({ sessionId: `r${i}`, position: 1, confirmedMinutes: 2 }),
      obs({ sessionId: `r${i}`, position: 2, confirmedMinutes: 9 }),
    ]);
    const r = learnDurations([...fast, ...rest]);
    expect(learnedSetupFor(r, "photo", "home")).toBeNull();
  });
});

describe("contexts are never mixed (AC1, AC5)", () => {
  it("home and phone-only learn separately", () => {
    const r = learnDurations([
      ...solos([4, 4, 4, 4, 4], { context: "home" }),
      ...solos([14, 14, 14, 14, 14], { context: "phone_only" }),
    ]);
    expect(learnedFor(r, "photo", "home")!.typicalMinutes).toBe(4);
    expect(learnedFor(r, "photo", "phone_only")!.typicalMinutes).toBe(14);
  });

  it("samples in one context never lift the other over the floor", () => {
    const r = learnDurations([
      ...solos([4, 4, 4], { context: "home" }),
      ...solos([14, 14, 14], { context: "phone_only" }),
    ]);
    expect(learnedFor(r, "photo", "home")).toBeNull();
    expect(learnedFor(r, "photo", "phone_only")).toBeNull();
  });
});

describe("two owners (AC4, AC5)", () => {
  it("learning is a pure function of the rows it is handed", () => {
    // NO OTHER SELLER'S HISTORY CAN REACH THIS. There is no global pool, no
    // cross-seller prior and no shared cache: the only way another owner's row
    // could influence the answer is if the caller fetched it, which is the
    // edge route's owner predicate and is asserted in the planner suite.
    const alice = learnDurations(solos([4, 4, 4, 4, 4]));
    const mallory = learnDurations(solos([40, 40, 40, 40, 40]));
    expect(learnedFor(alice, "photo", "home")!.typicalMinutes).toBe(4);
    expect(learnedFor(mallory, "photo", "home")!.typicalMinutes).toBe(40);
    // Re-running the first is unchanged by the second having happened.
    const again = learnDurations(solos([4, 4, 4, 4, 4]));
    expect(learnedFor(again, "photo", "home")!.typicalMinutes).toBe(4);
  });

  it("the module holds no state between calls", () => {
    expect(learnDurations([]).learned.size).toBe(0);
    expect(learnDurations([]).pools).toEqual([]);
  });
});

describe("precedence: override, then learned, then default (AC4)", () => {
  const learned = {
    typicalMinutes: 12,
    sampleCount: 9,
    observedLowMinutes: 8,
    observedHighMinutes: 20,
    allocation: "per_item" as const,
  };

  it("with nothing, the labeled default answers", () => {
    const d = estimateDuration({ action: "photograph" });
    expect(isUnestimated(d)).toBe(false);
    if (!isUnestimated(d)) {
      expect(d.source).toBe("default");
      expect(d.typical).toBe(8);
      expect(d.learnedFrom).toBeUndefined();
    }
  });

  it("a learned value beats the default and reports its evidence", () => {
    const d = estimateDuration({ action: "photograph", learned });
    if (isUnestimated(d)) throw new Error("should estimate");
    expect(d.source).toBe("learned");
    expect(d.typical).toBe(12);
    expect(d.learnedFrom).toEqual({
      sampleCount: 9,
      observedLowMinutes: 8,
      observedHighMinutes: 20,
      allocation: "per_item",
    });
    // The range is the seller's own, not the default's ratios rebuilt.
    expect(d.low).toBe(8);
    expect(d.high).toBe(20);
  });

  it("an override beats a learned value", () => {
    const d = estimateDuration({
      action: "photograph",
      learned,
      overrideTypicalMinutes: 3,
    });
    if (isUnestimated(d)) throw new Error("should estimate");
    expect(d.source).toBe("seller");
    expect(d.typical).toBe(3);
    expect(d.learnedFrom).toBeUndefined();
  });

  it("CLEARING an override falls back to learned, not to default", () => {
    // The whole of AC4's second half: clearing must not delete the learning.
    for (const cleared of [null, undefined]) {
      const d = estimateDuration({
        action: "photograph",
        learned,
        overrideTypicalMinutes: cleared,
      });
      if (isUnestimated(d)) throw new Error("should estimate");
      expect(d.source).toBe("learned");
      expect(d.typical).toBe(12);
    }
  });

  it("a learned value that is not a usable number is refused, not ignored", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = estimateDuration({
        action: "photograph",
        learned: { ...learned, typicalMinutes: bad },
      });
      // Refused rather than silently falling back to the default, which would
      // hide that the observations behind it are junk.
      expect(isUnestimated(d), `${bad} should be refused`).toBe(true);
    }
  });

  it("a range that does not contain the median is widened, never printed as is", () => {
    const d = estimateDuration({
      action: "photograph",
      learned: { ...learned, typicalMinutes: 30 },
    });
    if (isUnestimated(d)) throw new Error("should estimate");
    expect(d.typical).toBe(30);
    expect(d.high).toBe(30);
    expect(d.low).toBeLessThanOrEqual(30);
  });

  it("an unknown action stays unestimated even with a learned value", () => {
    // A learned median for a family says nothing about an action this module
    // has no model for, and zero minutes would sort it to the front.
    expect(isUnestimated(estimateDuration({ action: "teleport", learned }))).toBe(true);
  });
});

describe("not the marketing counter (AC5)", () => {
  it("this module never reaches for time-saved", () => {
    // work-duration.ts is already held to this by
    // work-duration-independence.test.ts. The learning file is under the same
    // rule: these are minutes a seller SPENT, and time-saved.ts counts
    // hypothetical minutes AVOIDED. One number moving must never move the
    // other.
    // SCANNED WITH COMMENTS STRIPPED, and that is not a detail. The header of
    // the file under test explains at length why it must never import
    // time-saved.ts, so a naive scan finds the banned phrase inside the
    // sentence forbidding it and fails on correct code. Block comments are
    // stripped AS BLOCKS first, because dropping lines that start with `//`
    // or `*` leaves the opening `/**` line in place.
    const src = codeOf("src/lib/work-duration-learning.ts");
    expect(src).not.toContain("time-saved");
    expect(src).not.toContain("TIME_SAVED");
    expect(src).not.toContain("minutesSaved");
    // Guards the guard: the stripper must not have eaten the whole file.
    expect(src).toContain("export function learnDurations");
  });
});

function codeOf(rel: string): string {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}
