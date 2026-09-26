// US-3536: public pages state the same tier ranges the certificate uses.
import { describe, expect, it } from "vitest";
import { SCALE_BANDS } from "@/lib/seo/platform-standards";
import { tierBandForScore } from "@/lib/constants";
import { GRADE_CHECKER_META } from "@/lib/seo/grade-checker";

const TIER_KEY: Record<string, string> = {
  "New With Tags": "NWT",
  "New Without Tags": "NWOT",
  Excellent: "Excellent",
  "Very Good": "Very Good",
  Good: "Good",
  Fair: "Fair",
  Poor: "Poor",
};

describe("US-3536 public tier ranges", () => {
  it("each platform-standards band's sample grade lands in its own tier", () => {
    for (const b of SCALE_BANDS) {
      expect(tierBandForScore(b.grade).tier, b.tier).toBe(TIER_KEY[b.tier]);
    }
  });

  it("the grade checker FAQ no longer states the old ranges", () => {
    const text = JSON.stringify(GRADE_CHECKER_META.faqs);
    expect(text).not.toContain("7.5+ is Excellent");
    expect(text).toContain("8.0 to 8.9 is Excellent");
  });
});
