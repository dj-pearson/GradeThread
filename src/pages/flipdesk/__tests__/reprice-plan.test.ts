import { describe, expect, it } from "vitest";
import { applyRefusalMessage, scanSummary } from "../reprice-plan";

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
