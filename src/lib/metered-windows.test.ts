// AL-10: metered multi-window passes stop at a quota wall, keep failed windows
// for a retry, and keep the windows a cancelled propose already paid for.
import { describe, expect, it, vi } from "vitest";
import { runMeteredWindows, trimTrailingPartialGroup } from "./metered-windows";

describe("runMeteredWindows (AL-10)", () => {
  it("a 402 mid-run sends no further requests", async () => {
    const send = vi.fn(async (w: number) =>
      w === 2 ? { ok: false as const, status: 402, error: "out" } : { ok: true as const, value: w },
    );
    const r = await runMeteredWindows([1, 2, 3, 4], send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(r.wall).toEqual({ status: 402, error: "out" });
    expect(r.completed.map((c) => c.value)).toEqual([1]);
    expect(r.unsent).toEqual([2, 3, 4]);
  });

  it("429 and 403 stop too; a 500 or a throw is a retryable failure", async () => {
    for (const status of [403, 429]) {
      const r = await runMeteredWindows([1, 2], async () => ({ ok: false as const, status, error: null }));
      expect(r.wall?.status).toBe(status);
      expect(r.failed).toEqual([]);
    }
    const r = await runMeteredWindows([1, 2, 3], async (w) => {
      if (w === 1) return { ok: false as const, status: 500, error: "boom" };
      if (w === 2) throw new Error("network");
      return { ok: true as const, value: w };
    });
    expect(r.failed).toEqual([1, 2]);
    expect(r.completed.map((c) => c.value)).toEqual([3]);
    expect(r.wall).toBeNull();
  });

  it("stops between windows when cancelled", async () => {
    let cancel = false;
    const r = await runMeteredWindows(
      [1, 2, 3, 4],
      async (w) => {
        if (w === 3) cancel = true;
        return { ok: true as const, value: w };
      },
      { isCancelled: () => cancel },
    );
    expect(r.cancelled).toBe(true);
    expect(r.completed.map((c) => c.value)).toEqual([1, 2, 3]);
    expect(r.unsent).toEqual([4]);
  });
});

describe("trimTrailingPartialGroup (AL-10)", () => {
  it("stopping after 3 windows keeps them, minus the last one's trailing group", () => {
    const res = [[["a"], ["b"]], [["c"]], [["d"], ["e"]]];
    expect(trimTrailingPartialGroup(res, true)).toEqual([[["a"], ["b"]], [["c"]], [["d"]]]);
  });

  it("a run that finished keeps everything", () => {
    const res = [[["a"], ["b"]]];
    expect(trimTrailingPartialGroup(res, false)).toEqual(res);
  });
});
