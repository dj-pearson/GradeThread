import { describe, expect, it } from "vitest";
import { limitingFlawSentence } from "@/lib/limiting-flaw";

// US-3330: one sentence, from words the server chose. No number reaches it.
describe("limitingFlawSentence", () => {
  it("names the flaw, where it is, and the tier it keeps the item from", () => {
    expect(
      limitingFlawSentence({ defect: "Small stain", location: "left cuff", next_tier: "Excellent" }),
    ).toBe("The small stain (left cuff) is what keeps this from Excellent.");
  });

  it("drops an empty location rather than printing empty brackets", () => {
    expect(limitingFlawSentence({ defect: "Pilling", location: "", next_tier: "Very Good" }))
      .toBe("The pilling is what keeps this from Very Good.");
  });

  it("says nothing when there is nothing to say", () => {
    expect(limitingFlawSentence(null)).toBeNull();
    expect(limitingFlawSentence(undefined)).toBeNull();
    expect(limitingFlawSentence({ defect: "", location: "x", next_tier: "Good" })).toBeNull();
  });
});
