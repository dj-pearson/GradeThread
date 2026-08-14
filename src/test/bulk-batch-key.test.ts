// US-2564: the client half of the bulk-grading charge token.
//
// The edge dedupes on `batch_key` + item id, so everything this token must be
// true about is a client-side property: stable across retries, different for a
// different batch, and short enough to survive the request schema.

import { describe, expect, it } from "vitest";
import { bulkBatchKey } from "@/lib/bulk-batch-key";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("bulkBatchKey", () => {
  it("is stable for the same selection and tier", () => {
    expect(bulkBatchKey([A, B], "standard")).toBe(bulkBatchKey([A, B], "standard"));
  });

  it("ignores selection ORDER — the same garments are the same batch", () => {
    // The seller ticking items bottom-up must not be charged a second time for
    // the same batch.
    expect(bulkBatchKey([A, B, C], "standard")).toBe(bulkBatchKey([C, A, B], "standard"));
  });

  it("does not mutate the caller's array", () => {
    // It sorts a copy. Sorting in place would silently reorder the list the UI
    // is rendering from.
    const ids = [C, A, B];
    bulkBatchKey(ids, "standard");
    expect(ids).toEqual([C, A, B]);
  });

  it("changes when the selection changes", () => {
    expect(bulkBatchKey([A, B], "standard")).not.toBe(bulkBatchKey([A, C], "standard"));
    expect(bulkBatchKey([A], "standard")).not.toBe(bulkBatchKey([A, B], "standard"));
  });

  it("changes when the TIER changes", () => {
    // Re-grading the same items at a higher tier is a real second charge and
    // must not be suppressed as a duplicate.
    expect(bulkBatchKey([A, B], "standard")).not.toBe(bulkBatchKey([A, B], "premium"));
  });

  it("returns null for an empty selection", () => {
    // A token for "no items" would be shared by every empty batch.
    expect(bulkBatchKey([], "standard")).toBeNull();
  });

  it("stays under the 255-character request cap at the 200-item limit", () => {
    // This is the constraint that killed the obvious implementation: joining the
    // sorted ids is ~37 bytes each, so a full batch is ~7.4 KB and the edge's
    // .strict() schema rejects the whole submit with a 400. A seller grading 200
    // items would have hit it on their first try.
    const ids = Array.from(
      { length: 200 },
      (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    const key = bulkBatchKey(ids, "standard");
    expect(key).not.toBeNull();
    expect(key!.length).toBeLessThanOrEqual(255);
    // And it is genuinely bounded, not merely under the cap for this input.
    expect(key!.length).toBeLessThan(40);
  });

  it("separates selections that differ only in size", () => {
    // The count is in the token precisely so a hash collision between two
    // different-length selections cannot merge them.
    const key1 = bulkBatchKey([A, B], "standard")!;
    const key2 = bulkBatchKey([A, B, C], "standard")!;
    expect(key1.split("-")[1]).toBe("2");
    expect(key2.split("-")[1]).toBe("3");
  });

  it("does not collide across a large set of distinct selections", () => {
    // Two 32-bit passes plus the count. One pass alone would put a seller with a
    // few thousand batches inside birthday range, and a collision there
    // suppresses a real charge — a garment silently dropped from a batch.
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const key = bulkBatchKey(
        [`${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, A],
        "standard",
      )!;
      seen.add(key);
    }
    expect(seen.size).toBe(5000);
  });
});
