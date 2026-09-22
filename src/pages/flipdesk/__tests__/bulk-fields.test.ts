// US-3467: a blank box leaves items alone; only the tick clears.
import { describe, it, expect } from "vitest";
import { planBulkFields } from "@/pages/flipdesk/bulk-fields";

const blank = { bin: "", clearBin: false, brand: "", clearBrand: false };

describe("planBulkFields", () => {
  it("blank form writes nothing", () => {
    expect(planBulkFields(blank)).toEqual({});
    expect(planBulkFields({ ...blank, bin: "   " })).toEqual({});
  });

  it("writes only the filled field, trimmed", () => {
    expect(planBulkFields({ ...blank, bin: " B2 " })).toEqual({ location_bin: "B2" });
    expect(planBulkFields({ ...blank, brand: "Patagonia" })).toEqual({ brand: "Patagonia" });
  });

  it("clearing is explicit and wins over a typed value", () => {
    expect(planBulkFields({ ...blank, bin: "B2", clearBin: true })).toEqual({ location_bin: null });
    expect(planBulkFields({ ...blank, clearBrand: true })).toEqual({ brand: null });
  });
});
