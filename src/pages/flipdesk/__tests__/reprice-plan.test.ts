import { describe, expect, it } from "vitest";
import {
  applyRefusalMessage,
  chunkRepriceItems,
  runChunkedApply,
  scanSummary,
  undoPriors,
} from "../reprice-plan";

describe("applyRefusalMessage", () => {
  it("names each server refusal in plain words", () => {
    expect(applyRefusalMessage("price_changed")).toBe(
      "Price changed since the scan. Scan this item again.",
    );
    expect(applyRefusalMessage("below_margin_floor")).toMatch(/under this item's floor/);
    expect(applyRefusalMessage("listing_not_active")).toMatch(/no longer live/);
    expect(applyRefusalMessage("not_pending")).toMatch(/already applied or dismissed/);
  });

  it("falls through for anything it does not know", () => {
    expect(applyRefusalMessage(undefined)).toBeNull();
    expect(applyRefusalMessage("toString")).toBeNull();
    expect(applyRefusalMessage("something_new")).toBeNull();
  });
});

describe("scanSummary", () => {
  it("reports listings the scan could not check", () => {
    expect(scanSummary({ scanned: 25, actionable: 4, errors: 3 })).toBe(
      "Scanned 25 listings. 4 repricing nudges. 3 listings could not be checked.",
    );
  });
  it("says nothing about errors when there were none", () => {
    expect(scanSummary({ scanned: 1, actionable: 1, errors: 0 })).toBe(
      "Scanned 1 listing. 1 repricing nudge.",
    );
  });
});

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ listing_id: `L${i}`, price_cents: 1000 + i }));
}

describe("chunked bulk apply", () => {
  it("splits 120 rows into 50/50/20 and merges the counts to 120", async () => {
    const sizes: number[] = [];
    const progress: string[] = [];
    const merged = await runChunkedApply(
      rows(120),
      async (chunk) => {
        sizes.push(chunk.length);
        return {
          applied: chunk.length,
          ebay_synced: chunk.length,
          applied_rows: chunk.map((c) => ({
            listing_id: c.listing_id,
            old_price_cents: 2000,
            new_price_cents: c.price_cents,
          })),
        };
      },
      (done, total) => progress.push(`${done}/${total}`),
    );
    expect(sizes).toEqual([50, 50, 20]);
    expect(merged.applied).toBe(120);
    expect(merged.applied_rows).toHaveLength(120);
    expect(progress).toEqual(["50/120", "100/120", "120/120"]);
  });

  it("marks a whole chunk failed when its request throws and keeps going", async () => {
    let n = 0;
    const merged = await runChunkedApply(rows(60), async (chunk) => {
      n++;
      if (n === 1) throw new Error("boom");
      return { applied: chunk.length };
    });
    expect(merged.errors).toHaveLength(50);
    expect(merged.applied).toBe(10);
  });

  it("chunks at 50 by default", () => {
    expect(chunkRepriceItems(rows(50))).toHaveLength(1);
    expect(chunkRepriceItems(rows(51)).map((c) => c.length)).toEqual([50, 1]);
  });
});

describe("undoPriors", () => {
  it("writes back only rows the server changed, at the price it replaced", async () => {
    const merged = await runChunkedApply(rows(3), async () => ({
      applied: 1,
      applied_rows: [{ listing_id: "L0", old_price_cents: 5500, new_price_cents: 1000 }],
      skipped: [{ listing_id: "L1", reason: "below_margin_floor" }],
      errors: [{ listing_id: "L2", message: "eBay said no" }],
    }));
    expect(undoPriors(merged.applied_rows)).toEqual([{ listing_id: "L0", price_cents: 5500 }]);
  });

  it("leaves out a row whose price did not actually move", () => {
    expect(
      undoPriors([{ listing_id: "L0", old_price_cents: 1000, new_price_cents: 1000 }]),
    ).toEqual([]);
  });
});
