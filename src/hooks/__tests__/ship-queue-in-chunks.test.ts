import { describe, expect, it } from "vitest";
import { IN_FILTER_CHUNK, inChunks } from "@/hooks/use-ship-queue";

// US-3298. The ship queue read cost basis and profit for every unshipped sale in
// one PostgREST `in.(...)` filter. At 210 ids that request line is 8,283
// characters and the gateway drops it before writing a CORS header, so Chrome
// reports "blocked by CORS policy", names no status, and points at the wrong
// problem. Measured on production 2026-09-09: 205 ids / 8,088 chars -> 200,
// 210 ids / 8,283 chars -> failed.
//
// The read is best-effort by design, so the seller saw a ship queue with the
// money columns blank and nothing to say why.

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("inChunks", () => {
  it("keeps every request under the 8 KB request line, with room to spare", () => {
    // 39 characters per UUID once supabase-js percent-encodes the separating
    // comma. This is the arithmetic the constant exists to satisfy, written out
    // so raising it fails here rather than in production four months later.
    expect(IN_FILTER_CHUNK * 39).toBeLessThan(8088 / 2 + 100);
    expect(IN_FILTER_CHUNK).toBeLessThanOrEqual(102);
  });

  it("splits the count that actually broke into whole slices", () => {
    const seen: number[] = [];
    return inChunks(ids(210), async (slice) => {
      seen.push(slice.length);
      return slice;
    }).then((out) => {
      expect(seen).toEqual([100, 100, 10]);
      expect(out).toHaveLength(210);
    });
  });

  it("concatenates in order, so a 'first row wins' dedupe still sees the newest", () => {
    // The listing-link map keeps the first row per item and relies on the
    // per-request `order by listed_at desc`. Chunks are disjoint sets of items,
    // so that holds — but only if the slices are concatenated in order.
    return inChunks(ids(5), async (slice) => slice.map((v) => v.toUpperCase())).then((out) => {
      expect(out).toEqual(["ID-0", "ID-1", "ID-2", "ID-3", "ID-4"]);
    });
  });

  it("makes no request at all for an empty list", async () => {
    let calls = 0;
    const out = await inChunks<string>([], async (slice) => {
      calls += 1;
      return slice;
    });
    expect(calls).toBe(0);
    expect(out).toEqual([]);
  });

  it("propagates a failure instead of returning a short list", async () => {
    // A partial answer is worse than none here: it would render some rows with
    // profit and some without, which reads as data rather than as an outage.
    await expect(
      inChunks(ids(150), async (slice) => {
        if (slice[0] !== "id-0") throw new Error("boom");
        return slice;
      }),
    ).rejects.toThrow("boom");
  });
});
