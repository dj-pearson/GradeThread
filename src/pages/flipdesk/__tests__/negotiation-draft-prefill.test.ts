// US-2494: the AI draft may seed an untouched field and nothing else. A draft
// that overwrites a typed counter price is worse than no draft at all, because
// the seller sends a number they never chose.
import { describe, it, expect } from "vitest";
import { applyNegotiationDraft } from "@/pages/flipdesk/negotiation-draft-prefill";

describe("applyNegotiationDraft", () => {
  it("seeds both fields when the form is untouched", () => {
    expect(
      applyNegotiationDraft(
        { price: "", note: "" },
        { message: "Thanks for the offer.", suggested_counter: 42.5 },
      ),
    ).toEqual({ price: "42.50", note: "Thanks for the offer." });
  });

  it("keeps a typed price and a typed note", () => {
    expect(
      applyNegotiationDraft(
        { price: "38", note: "my own words" },
        { message: "drafted", suggested_counter: 42.5 },
      ),
    ).toEqual({ price: "38", note: "my own words" });
  });

  it("treats whitespace as untouched", () => {
    expect(
      applyNegotiationDraft(
        { price: "  ", note: "\n " },
        { message: "drafted", suggested_counter: 20 },
      ),
    ).toEqual({ price: "20.00", note: "drafted" });
  });

  it("leaves the price alone when the server suggests none", () => {
    expect(
      applyNegotiationDraft(
        { price: "", note: "" },
        { message: "drafted", suggested_counter: null },
      ),
    ).toEqual({ price: "", note: "drafted" });
  });

  it("ignores a non-positive or non-finite suggestion", () => {
    for (const suggested of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        applyNegotiationDraft(
          { price: "", note: "" },
          { message: "drafted", suggested_counter: suggested },
        ).price,
      ).toBe("");
    }
  });
});
