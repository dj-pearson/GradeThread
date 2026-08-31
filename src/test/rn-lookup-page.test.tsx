// US-9033: the RN lookup hub's two jobs — accept a number in any spelling a
// label prints, and say what an RN can and cannot tell you before anyone acts
// on the answer.

import { describe, expect, it } from "vitest";
import { normalizeRnInput } from "@/pages/tools/rn-lookup";
import { RN_LOOKUP_META, RN_LOOKUP_PATH, TAG_READ_ENDPOINT } from "@/lib/seo/rn-lookup";

describe("rn lookup hub", () => {
  it("accepts every spelling a care label prints", () => {
    for (const raw of ["56323", "RN 56323", "rn56323", "RN# 56323", "056323", " 56323 ", "CA 32054"]) {
      expect(normalizeRnInput(raw), raw).not.toBeNull();
    }
    expect(normalizeRnInput("RN 56323")).toBe("56323");
    expect(normalizeRnInput("056323")).toBe("56323");
    expect(normalizeRnInput("CA 32054")).toBe("32054");
  });

  it("refuses what is not a registry number", () => {
    for (const raw of ["", "   ", "abc", "1", "12345678", "56323-2", "http://x"]) {
      expect(normalizeRnInput(raw), raw).toBeNull();
    }
  });

  it("says what an RN cannot prove, on the page itself", () => {
    const copy = [RN_LOOKUP_META.intro, ...RN_LOOKUP_META.faqs.map((f) => f.a)].join(" ");
    expect(copy).toMatch(/never the brand/i);
    expect(copy).toMatch(/counterfeit/i);
    expect(copy).toMatch(/corroboration/i);
  });

  it("points at the endpoints the page actually calls", () => {
    expect(TAG_READ_ENDPOINT).toBe("/api/grading/public/tag-read");
    expect(RN_LOOKUP_PATH).toBe("/tools/rn-lookup");
  });

  it("names its source so a reader can check us", () => {
    const copy = RN_LOOKUP_META.faqs.map((f) => f.a).join(" ");
    expect(copy).toMatch(/FTC/);
  });
});
