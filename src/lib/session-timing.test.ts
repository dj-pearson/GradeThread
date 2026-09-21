// US-3176: what a running session knows, and what it refuses to claim.
//
// The hidden-tab cases below are the reason this file exists. Both of the
// obvious implementations pass a naive test suite: subtracting hidden time
// gives tidy numbers, and counting it gives tidy numbers. What neither gives
// is an honest one, so the assertions here are written against the BEHAVIOUR
// (the clock is not adjusted, and the gap is reported) rather than against a
// total.

import { describe, it, expect } from "vitest";
import {
  HIDDEN_NOISE_FLOOR_MS,
  hiddenMsDuring,
  reconcile,
  sessionProgress,
  timingCertainty,
  type SessionTaskView,
} from "@/lib/session-timing";
import type { ItemListRow } from "@/lib/item-list-columns";

const MIN = 60_000;
const T0 = Date.parse("2026-09-21T10:00:00.000Z");

function task(over: Partial<SessionTaskView> = {}): SessionTaskView {
  return {
    id: "t1",
    position: 1,
    state: "pending",
    action_key: "measure",
    inventory_item_id: "i1",
    item_title: "Carhartt Detroit jacket",
    bin: "A-14",
    estimate_minutes: 5,
    actionable: true,
    ...over,
  };
}

describe("hiddenMsDuring", () => {
  it("counts only the overlap with the window", () => {
    // Hidden from -5min to +3min; only 3 minutes are inside the window.
    expect(
      hiddenMsDuring([{ from: T0 - 5 * MIN, to: T0 + 3 * MIN }], T0, T0 + 10 * MIN),
    ).toBe(3 * MIN);
  });

  it("clamps a span still open to the end of the window", () => {
    // THE COMMONEST CASE AT THE MOMENT IT MATTERS: the tab is hidden right
    // now, because the seller is holding a camera, and they come back and
    // press Done. Ignoring an open span would report zero for exactly this.
    expect(
      hiddenMsDuring([{ from: T0 + 2 * MIN, to: null }], T0, T0 + 10 * MIN),
    ).toBe(8 * MIN);
  });

  it("adds separate spans and ignores ones outside the window", () => {
    expect(
      hiddenMsDuring(
        [
          { from: T0 + 1 * MIN, to: T0 + 2 * MIN },
          { from: T0 + 4 * MIN, to: T0 + 6 * MIN },
          { from: T0 + 40 * MIN, to: T0 + 50 * MIN },
        ],
        T0,
        T0 + 10 * MIN,
      ),
    ).toBe(3 * MIN);
  });

  it("is zero for an inverted or empty window rather than negative", () => {
    expect(hiddenMsDuring([{ from: T0, to: T0 + MIN }], T0 + 10 * MIN, T0)).toBe(0);
    expect(hiddenMsDuring([], T0, T0 + MIN)).toBe(0);
  });
});

describe("timingCertainty: the clock is never adjusted (AC3)", () => {
  it("reports the whole elapsed window even when most of it was hidden", () => {
    const c = timingCertainty({
      startedAt: T0,
      endedAt: T0 + 12 * MIN,
      hidden: [{ from: T0 + 1 * MIN, to: T0 + 11 * MIN }],
    });
    // THE ASSERTION THAT MATTERS: 12, not 2. Subtracting the hidden ten
    // minutes would train the photography estimate toward zero, because
    // photographing is exactly when the tab is not being looked at.
    expect(c.observedMinutes).toBe(12);
    expect(c.hiddenMinutes).toBe(10);
    expect(c.uncertain).toBe(true);
  });

  it("says a hidden stretch happened without claiming which way it went", () => {
    const c = timingCertainty({
      startedAt: T0,
      endedAt: T0 + 12 * MIN,
      hidden: [{ from: T0 + 1 * MIN, to: T0 + 11 * MIN }],
    });
    expect(c.sentence).toContain("background");
    expect(c.sentence).toContain("10");
    // Both readings are offered. A sentence that picked one would be wrong
    // about half the time while sounding certain both times.
    expect(c.sentence).toMatch(/working/i);
    expect(c.sentence).toMatch(/away/i);
    for (const overclaim of ["you were away", "you stopped", "idle", "inactive"]) {
      expect(c.sentence.toLowerCase()).not.toContain(overclaim);
    }
  });

  it("says nothing at all about a glance at another tab", () => {
    const c = timingCertainty({
      startedAt: T0,
      endedAt: T0 + 12 * MIN,
      hidden: [{ from: T0 + 1 * MIN, to: T0 + 1 * MIN + HIDDEN_NOISE_FLOOR_MS - 1 }],
    });
    expect(c.uncertain).toBe(false);
    // An empty sentence is the signal not to render the line. Asking every
    // time trains the seller to dismiss the question.
    expect(c.sentence).toBe("");
  });

  it("never reports zero minutes for work that happened", () => {
    // 25 seconds rounds to 0, and a recorded 0 is not a small number: it is a
    // claim that the task is free, which is what R2 would learn from.
    const quick = timingCertainty({ startedAt: T0, endedAt: T0 + 25_000, hidden: [] });
    expect(quick.observedMinutes).toBe(1);
    // Zero is still available for the case where it is true.
    expect(timingCertainty({ startedAt: T0, endedAt: T0, hidden: [] }).observedMinutes)
      .toBe(0);
  });

  it("is clean when the tab never hid", () => {
    const c = timingCertainty({ startedAt: T0, endedAt: T0 + 7 * MIN, hidden: [] });
    expect(c).toMatchObject({ observedMinutes: 7, hiddenMinutes: 0, uncertain: false });
    expect(c.sentence).toBe("");
  });
});

describe("sessionProgress", () => {
  it("makes the running task current, whatever its position", () => {
    const p = sessionProgress([
      task({ id: "a", position: 1, state: "pending" }),
      task({ id: "b", position: 2, state: "active" }),
    ]);
    expect(p.current?.id).toBe("b");
    expect(p.currentIsActive).toBe(true);
  });

  it("offers the first open task when none is running", () => {
    const p = sessionProgress([
      task({ id: "a", position: 2, state: "pending" }),
      task({ id: "b", position: 1, state: "pending" }),
    ]);
    // Plan order, not array order. Re-sorting by anything else would undo six
    // stories of ranking and batching.
    expect(p.current?.id).toBe("b");
    expect(p.currentIsActive).toBe(false);
  });

  it("never offers a task whose item is gone", () => {
    const p = sessionProgress([
      task({ id: "a", position: 1, state: "pending", actionable: false }),
      task({ id: "b", position: 2, state: "pending" }),
    ]);
    expect(p.current?.id).toBe("b");
    expect(p.upcoming.map((t) => t.id)).toEqual([]);
  });

  it("counts the current task's minutes as remaining until it is running", () => {
    const waiting = sessionProgress([
      task({ id: "a", position: 1, state: "pending", estimate_minutes: 5 }),
      task({ id: "b", position: 2, state: "pending", estimate_minutes: 8 }),
    ]);
    expect(waiting.remainingMinutes).toBe(13);

    const running = sessionProgress([
      task({ id: "a", position: 1, state: "active", estimate_minutes: 5 }),
      task({ id: "b", position: 2, state: "pending", estimate_minutes: 8 }),
    ]);
    // 8, not 13: the active task's minutes are being spent, not waiting.
    expect(running.remainingMinutes).toBe(8);
  });

  it("sums CONFIRMED minutes only, never a clock reading", () => {
    const p = sessionProgress([
      task({ id: "a", state: "completed", confirmed_minutes: 7, estimate_minutes: 5 }),
      // Finished without an answer. It contributes nothing, which is why this
      // total can read lower than the wall clock and should.
      task({ id: "b", position: 2, state: "completed", confirmed_minutes: null }),
    ]);
    expect(p.confirmedMinutes).toBe(7);
    expect(p.done).toHaveLength(2);
  });

  it("separates skipped from closed-under-them", () => {
    const p = sessionProgress([
      task({ id: "a", position: 1, state: "skipped" }),
      task({ id: "b", position: 2, state: "invalidated" }),
    ]);
    // A skip is a CHOICE and R2's learning reads it as one; an invalidation is
    // the world moving. Collapsing them would teach the ranker that the seller
    // dislikes work they never saw.
    expect(p.skipped.map((t) => t.id)).toEqual(["a"]);
    expect(p.invalidated.map((t) => t.id)).toEqual(["b"]);
    expect(p.allSettled).toBe(true);
  });

  it("counts what was left over WITHOUT depending on which task is current", () => {
    // THE BUG THIS CAME FROM: the finish screen reported `upcoming.length +
    // skipped.length`, and `upcoming` deliberately excludes `current`. A
    // session ended with exactly one pending job counted zero and the screen
    // told the seller nothing had been carried over.
    const one = sessionProgress([
      task({ id: "a", position: 1, state: "completed", confirmed_minutes: 7 }),
      task({ id: "b", position: 2, state: "pending" }),
    ]);
    expect(one.upcoming).toHaveLength(0);
    expect(one.leftOverCount).toBe(1);

    const both = sessionProgress([
      task({ id: "a", position: 1, state: "completed" }),
      task({ id: "b", position: 2, state: "pending" }),
      task({ id: "c", position: 3, state: "skipped" }),
    ]);
    expect(both.leftOverCount).toBe(2);
  });

  it("nothing left over when everything finished", () => {
    const p = sessionProgress([
      task({ id: "a", position: 1, state: "completed" }),
      // An item that sold under the seller is not work they still owe.
      task({ id: "b", position: 2, state: "invalidated", actionable: false }),
    ]);
    expect(p.leftOverCount).toBe(0);
  });

  it("an empty session is not a settled one", () => {
    // Vacuous truth would make `every` answer true and the screen announce a
    // finished session that never had a task in it.
    expect(sessionProgress([]).allSettled).toBe(false);
  });
});

describe("reconcile: a report, never a gate (AC2)", () => {
  const item = (over: Partial<ItemListRow>) => over as ItemListRow;

  it("sees measurements that landed", () => {
    expect(reconcile("measure", item({ measurements: { chest: 22 } })).landed).toBe(true);
  });

  it("says plainly when it cannot see the work", () => {
    const r = reconcile("measure", item({ measurements: null }));
    expect(r.landed).toBe(false);
    expect(r.note).toContain("measurements");
  });

  it("reads each action against its own durable fact", () => {
    expect(reconcile("photograph", item({ has_required_photos: true })).landed).toBe(true);
    expect(reconcile("photograph", item({ has_required_photos: false })).landed).toBe(false);
    expect(reconcile("price_research", item({ target_price: 40 })).landed).toBe(true);
    expect(reconcile("price_research", item({ target_price: null })).landed).toBe(false);
    expect(reconcile("draft_review", item({ listing_id: "l1" })).landed).toBe(true);
    expect(reconcile("draft_review", item({ listing_id: null })).landed).toBe(false);
  });

  it("stays quiet for an action it has no business checking", () => {
    // Publishing and shipping have their own routes, their own confirmations
    // and their own failures. A check invented here would be a second opinion
    // about a fact somebody else owns.
    for (const action of ["publish", "pack_ship", "review_grade"]) {
      const r = reconcile(action, item({ measurements: null }));
      expect(r.landed, `${action} should not be second-guessed here`).toBe(true);
      expect(r.note).toBe("");
    }
  });

  it("stays quiet while the item is still loading", () => {
    // A warning that flickers on every reload is a warning nobody reads. An
    // absent item is not evidence that work did not land.
    expect(reconcile("measure", null)).toEqual({ landed: true, note: "" });
    expect(reconcile("measure", undefined)).toEqual({ landed: true, note: "" });
  });

  it("no note ever accuses the seller of not doing the work", () => {
    // The system's own uncertainty, phrased as the system's. "We still don't
    // see X" is true; "you didn't do X" is a guess, and it is wrong whenever
    // the seller measured on paper.
    for (const action of ["measure", "photograph", "price_research", "draft_review"]) {
      const note = reconcile(action, item({})).note;
      expect(note, action).toMatch(/^We still don't see/);
      expect(note.toLowerCase()).not.toContain("you didn't");
      expect(note.toLowerCase()).not.toContain("you have not");
    }
  });
});
