import { describe, expect, it } from "vitest";
import { PhotoPrepError, uploadInPool } from "@/lib/item-photo-upload";
import { batchSortOrders } from "@/lib/photo-order";

describe("uploadInPool", () => {
  it("never runs more than the limit, retries once, and keeps task order", async () => {
    let active = 0;
    let peak = 0;
    const tries: Record<number, number> = {};
    const out = await uploadInPool([0, 1, 2, 3, 4], async (n) => {
      tries[n] = (tries[n] ?? 0) + 1;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      if (n === 1) throw new Error("always");
      if (n === 3 && tries[n] === 1) throw new Error("once");
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(out.map((o) => o.ok)).toEqual([true, false, true, true, true]);
    expect(tries[1]).toBe(2);
    expect(tries[3]).toBe(2);
    expect(out[4]).toMatchObject({ ok: true, result: 40 });
  });

  it("does not retry a photo the device cannot prepare", async () => {
    let calls = 0;
    const out = await uploadInPool(["heic"], async () => {
      calls++;
      throw new PhotoPrepError("Couldn't convert");
    });
    expect(calls).toBe(1);
    expect(out[0]!.ok).toBe(false);
  });
});

describe("batchSortOrders", () => {
  it("puts front first whatever order the photos were picked in", () => {
    const [tag, front, back, front2] = batchSortOrders(["tag", "front", "back", "front"]);
    expect(front).toBe(0);
    expect(front2).toBe(1);
    expect(front2!).toBeLessThan(back!);
    expect(back!).toBeLessThan(tag!);
  });
});
