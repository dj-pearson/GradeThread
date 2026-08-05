// US-2404: bulk resubmit — the pure halves of the client action.
//
// The mutation itself needs a server, but the two things that can quietly go
// wrong here do not: how a selection is split into requests, and what the seller
// is told afterwards. The second is the one with history — bulk price shipped a
// summary that reported rows the marketplace had refused as "updated locally
// only", and the whole point of this action is that a listing eBay refused is
// still showing the OLD content to buyers.

import { describe, it, expect } from "vitest";
import {
  BULK_REVISE_CHUNK_SIZE,
  chunkForBulkRevise,
  describeBulkRevise,
  mergeBulkReviseResponses,
  type BulkReviseResponse,
} from "@/hooks/use-listing-lifecycle";

function res(rows: Array<{ id: string; ok: boolean; error?: string }>): BulkReviseResponse {
  const results = rows.map((r) => ({
    listing_id: r.id,
    ok: r.ok,
    status: r.ok ? 200 : 409,
    ...(r.error ? { error: r.error } : {}),
  }));
  const pushed = results.filter((r) => r.ok).length;
  return { ok: true, requested: results.length, pushed, failed: results.length - pushed, results };
}

describe("chunkForBulkRevise", () => {
  it("splits a selection into requests of the chunk size", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `l${i}`);
    const chunks = chunkForBulkRevise(ids);
    expect(chunks).toHaveLength(Math.ceil(60 / BULK_REVISE_CHUNK_SIZE));
    expect(chunks.flat()).toEqual(ids); // nothing dropped, order preserved
    expect(chunks[0]).toHaveLength(BULK_REVISE_CHUNK_SIZE);
  });

  it("returns one chunk for a small selection and none for an empty one", () => {
    expect(chunkForBulkRevise(["a", "b"])).toEqual([["a", "b"]]);
    expect(chunkForBulkRevise([])).toEqual([]);
  });

  it("never loses items if the size is nonsense", () => {
    expect(chunkForBulkRevise(["a", "b"], 0)).toEqual([["a", "b"]]);
  });
});

describe("mergeBulkReviseResponses", () => {
  it("keeps every per-row result and recounts from them", () => {
    const merged = mergeBulkReviseResponses([
      res([{ id: "a", ok: true }, { id: "b", ok: false, error: "eBay said no" }]),
      res([{ id: "c", ok: true }]),
    ]);
    expect(merged.results.map((r) => r.listing_id)).toEqual(["a", "b", "c"]);
    expect(merged.pushed).toBe(2);
    expect(merged.failed).toBe(1);
    expect(merged.requested).toBe(3);
  });

  it("recounts rather than trusting the parts' own totals", () => {
    // A part claiming more pushes than its rows support must not survive the
    // merge — the count the seller reads is derived from the rows, always.
    const lying: BulkReviseResponse = {
      ok: true,
      requested: 1,
      pushed: 99,
      failed: 0,
      results: [{ listing_id: "a", ok: false, status: 409, error: "refused" }],
    };
    const merged = mergeBulkReviseResponses([lying]);
    expect(merged.pushed).toBe(0);
    expect(merged.failed).toBe(1);
  });
});

describe("describeBulkRevise", () => {
  it("says plainly how many went up when all of them did", () => {
    expect(describeBulkRevise(res([{ id: "a", ok: true }]))).toBe(
      "1 listing resubmitted to eBay.",
    );
    expect(describeBulkRevise(res([{ id: "a", ok: true }, { id: "b", ok: true }]))).toBe(
      "2 listings resubmitted to eBay.",
    );
  });

  it("never claims a refused listing was pushed", () => {
    const msg = describeBulkRevise(
      res([{ id: "a", ok: true }, { id: "b", ok: false }, { id: "c", ok: false }]),
    );
    expect(msg).toContain("1 resubmitted");
    expect(msg).toContain("2 refused");
  });

  it("is explicit that nothing changed when every row was refused", () => {
    const msg = describeBulkRevise(res([{ id: "a", ok: false }, { id: "b", ok: false }]));
    expect(msg).toContain("Nothing was changed");
    expect(msg).not.toMatch(/\b0 resubmitted/); // not a bare zero the eye skips
  });
});
