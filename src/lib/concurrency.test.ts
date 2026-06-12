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
    const done: number[] = [];
    await runWithConcurrency([50, 1, 1, 1, 1], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      done.push(i);
    });
    // Lane 2 should finish all four fast items while lane 1 sits on item 0.
    expect(done[done.length - 1]).toBe(0);
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
