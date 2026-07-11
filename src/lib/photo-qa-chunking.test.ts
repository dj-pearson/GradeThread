import { describe, expect, it, vi } from "vitest";
import { MAX_QA_ITEMS, runChunkedQa } from "./photo-qa-chunking";

// US-1911: chunk a >100-item QA request into ≤100-per-request calls, issued
// sequentially, merging partials and isolating a failed chunk.

const ids = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);

describe("runChunkedQa", () => {
  it("issues chunks of ≤ maxPerRequest sequentially and in order", async () => {
    const seen: string[][] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const fetchChunk = vi.fn(async (batch: string[]) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      inFlight--;
      seen.push(batch);
      return batch.map((id) => ({ id, score: 90 }));
    });

    const { results, failed } = await runChunkedQa(ids(300), fetchChunk, {
      maxPerRequest: 100,
    });

    expect(fetchChunk).toHaveBeenCalledTimes(3);
    expect(seen.map((b) => b.length)).toEqual([100, 100, 100]);
    // sequential: never two requests in flight at once
    expect(maxConcurrent).toBe(1);
    // merged in original order, nothing lost
    expect(results.map((r) => r.id)).toEqual(ids(300));
    expect(failed).toEqual([]);
  });

  it("defaults the cap to MAX_QA_ITEMS (100)", async () => {
    const fetchChunk = vi.fn(async (batch: string[]) =>
      batch.map((id) => ({ id })),
    );
    await runChunkedQa(ids(250), fetchChunk);
    expect(MAX_QA_ITEMS).toBe(100);
    expect(fetchChunk).toHaveBeenCalledTimes(3); // 100 + 100 + 50
  });

  it("isolates a failed chunk: others still score, failed items are reported", async () => {
    const fetchChunk = vi.fn(async (batch: string[]) => {
      // fail only the middle chunk (starts at i100)
      if (batch[0] === "i100") throw new Error("boom");
      return batch.map((id) => ({ id, score: 88 }));
    });

    const onChunkError = vi.fn();
    const { results, failed } = await runChunkedQa(ids(300), fetchChunk, {
      maxPerRequest: 100,
      onChunkError,
    });

    // chunk 1 (0-99) and chunk 3 (200-299) succeeded; chunk 2 (100-199) failed
    expect(results).toHaveLength(200);
    expect(results.map((r) => r.id)).toEqual([...ids(100), ...ids(300).slice(200)]);
    expect(failed).toEqual(ids(300).slice(100, 200));
    expect(onChunkError).toHaveBeenCalledTimes(1);
  });

  it("merges partials as each chunk resolves (onPartial per chunk)", async () => {
    const partials: number[] = [];
    const { results } = await runChunkedQa(
      ids(250),
      async (batch) => batch.map((id) => ({ id })),
      { maxPerRequest: 100, onPartial: (r) => partials.push(r.length) },
    );
    expect(partials).toEqual([100, 100, 50]);
    expect(results).toHaveLength(250);
  });

  it("returns empty results and no failures for an empty list", async () => {
    const fetchChunk = vi.fn(async (batch: string[]) => batch.map((id) => ({ id })));
    const { results, failed } = await runChunkedQa([], fetchChunk);
    expect(results).toEqual([]);
    expect(failed).toEqual([]);
    expect(fetchChunk).not.toHaveBeenCalled();
  });
});
