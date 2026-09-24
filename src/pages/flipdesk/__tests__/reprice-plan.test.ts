import { describe, expect, it } from "vitest";
import { applyRefusalMessage } from "../reprice-plan";

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
