import { describe, expect, it } from "vitest";
import { runPool } from "@/lib/async-pool";

describe("runPool", () => {
  it("keeps at most 4 in flight and returns results in input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await runPool(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later items finish first, so order has to come from the index.
      await new Promise((r) => setTimeout(r, (20 - n) % 5));
      inFlight--;
      return n * 10;
    });
    expect(peak).toBe(4);
    expect(out).toEqual(items.map((n) => n * 10));
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([]);
    expect(await runPool([1, 2], 8, async (n) => n + 1)).toEqual([2, 3]);
  });

  it("rejects when a call rejects", async () => {
    await expect(
      runPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
