import { describe, expect, it } from "vitest";
import { uniqueName, uniqueNames } from "@/lib/starter-presets";

const MAX = 80;

describe("uniqueName", () => {
  it("leaves a free name alone", () => {
    expect(uniqueName("Returns", ["Ships fast"], MAX)).toBe("Returns");
  });

  it("adds (copy) on the first collision", () => {
    expect(uniqueName("Returns", ["Returns"], MAX)).toBe("Returns (copy)");
  });

  it("counts from two on the second collision", () => {
    expect(uniqueName("Returns", ["Returns", "Returns (copy)"], MAX)).toBe(
      "Returns (copy 2)",
    );
  });

  it("compares case-insensitively and trimmed, the way nameProblem does", () => {
    expect(uniqueName("Returns", ["  returns  "], MAX)).toBe("Returns (copy)");
  });

  it("truncates the base rather than the suffix when the cap bites", () => {
    const base = "R".repeat(MAX);
    const out = uniqueName(base, [base], MAX);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out.endsWith(" (copy)")).toBe(true);
  });
});

describe("uniqueNames", () => {
  it("dodges names picked earlier in the same batch", () => {
    // Both samples collide with the one existing row. Without the running
    // list, both would become "Returns (copy)" and the second insert would be
    // the duplicate error the rename exists to prevent.
    expect(uniqueNames(["Returns", "Returns"], ["Returns"], MAX)).toEqual([
      "Returns (copy)",
      "Returns (copy 2)",
    ]);
  });

  it("passes free names through unchanged", () => {
    expect(uniqueNames(["A", "B"], [], MAX)).toEqual(["A", "B"]);
  });
});
