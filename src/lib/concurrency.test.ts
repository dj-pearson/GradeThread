import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "./concurrency";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("runWithConcurrency", () => {
  it("processes every item exactly once with the right index", async () => {
    const seen: Array<[string, number]> = [];
    await runWithConcurrency(["a", "b", "c", "d"], 2, async (item, i) => {
      await tick();
      seen.push([item, i]);
    });
    expect(seen).toHaveLength(4);
    expect(new Map(seen)).toEqual(
      new Map([
        ["a", 0],
        ["b", 1],
        ["c", 2],
        ["d", 3],
      ]),
    );
  });

  it("never runs more than `limit` tasks at once", async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // genuinely parallel, not serialized
  });

  it("slides: a slow item does not stall the other lanes", async () => {
    // US-2000: this test USED TO RACE THE WALL CLOCK, and it was the flake.
    //
    // It ran [50, 1, 1, 1, 1] through real setTimeouts and asserted that item 0
    // (the 50ms one) finished last. That required lane 2 to complete FOUR
    // sequential 1ms timers inside lane 1's single 50ms window — roughly a 4x
    // margin. Node timer callbacks drift well past their nominal delay on a
    // loaded runner with parallel vitest workers, so when the four short timers
    // averaged >12.5ms the ordering inverted and the suite went red with
    // "expected 4 to be +0". Measured at roughly 1 run in 8.
    //
    // Rewritten to assert the same property with NO timers at all: the slow
    // item cannot complete until every fast item has. That removes the race
    // entirely rather than hiding it behind a retry or a longer sleep — a retry
    // would have converted a real intermittent defect into an invisible one.
    //
    // It also tests the property MORE strictly than the timing version did: if
    // the pool ever stopped sliding (i.e. blocked on the slow item instead of
    // feeding the other lane), the fast items would never run, `allFastDone`
    // would never resolve, and this DEADLOCKS into a test timeout rather than
    // passing by luck.
    const done: number[] = [];
    const FAST_COUNT = 4;
    let fastFinished = 0;
    let releaseSlow!: () => void;
    const allFastDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    await runWithConcurrency([0, 1, 2, 3, 4], 2, async (_item, i) => {
      if (i === 0) {
        await allFastDone; // the "slow" lane — gated on real progress, not time
        done.push(i);
        return;
      }
      done.push(i);
      if (++fastFinished === FAST_COUNT) releaseSlow();
    });

    expect(done).toHaveLength(5);
    expect(done[done.length - 1]).toBe(0);
    // And every fast item really did run while item 0 was outstanding.
    expect(done.slice(0, FAST_COUNT).sort()).toEqual([1, 2, 3, 4]);
  });

  it("handles empty input and clamps a zero/negative limit to 1", async () => {
    await expect(runWithConcurrency([], 4, () => Promise.resolve())).resolves.toBeUndefined();
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 0, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([1, 2, 3]);
  });
});
