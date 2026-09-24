import { describe, expect, it } from "vitest";
import {
  bandReturnFinding,
  gradedReturnFinding,
  type ReturnReductionSummary,
} from "@/lib/flipdesk-returns-analytics";

// A4: a zero return rate is the best case, not "not enough sales".

const stat = (sold: number, returns: number) => ({
  sold,
  returns,
  returnRate: sold > 0 ? returns / sold : null,
});

function summary(
  graded: [number, number],
  ungraded: [number, number],
  low: [number, number] = [0, 0],
  high: [number, number] = [0, 0],
): ReturnReductionSummary {
  return {
    overall: stat(graded[0] + ungraded[0], graded[1] + ungraded[1]),
    graded: stat(...graded),
    ungraded: stat(...ungraded),
    bands: [
      { key: "low", label: "graded below 6.5", ...stat(...low) },
      { key: "high", label: "graded 8.5-10.0", ...stat(...high) },
    ],
  };
}

describe("gradedReturnFinding", () => {
  it("zero graded returns on a large sample is the 'none came back' case", () => {
    // 0 of 40 graded vs 6 of 50 ungraded (12%).
    expect(gradedReturnFinding(summary([40, 0], [50, 6]))).toEqual({
      kind: "zero",
      sample: 40,
      otherRate: 0.12,
    });
  });

  it("both zero is nothing to claim, not 'not enough'", () => {
    expect(gradedReturnFinding(summary([40, 0], [50, 0]))).toBeNull();
  });

  it("a small sample is insufficient even when it looks perfect", () => {
    expect(gradedReturnFinding(summary([4, 0], [50, 6]))).toEqual({
      kind: "insufficient",
    });
    expect(gradedReturnFinding(summary([40, 0], [9, 6]))).toEqual({
      kind: "insufficient",
    });
  });

  it("keeps the multiplier when both sides have returns", () => {
    const f = gradedReturnFinding(summary([10, 1], [10, 5]));
    expect(f?.kind).toBe("multiplier");
    expect(f && f.kind === "multiplier" ? f.n : 0).toBeCloseTo(5);
  });

  it("never spins a worse graded rate", () => {
    expect(gradedReturnFinding(summary([100, 20], [100, 10]))).toBeNull();
  });
});

describe("bandReturnFinding", () => {
  it("zero high-band returns is the 'none came back' case", () => {
    const r = bandReturnFinding(summary([0, 0], [0, 0], [20, 4], [30, 0]));
    expect(r?.finding).toEqual({ kind: "zero", sample: 30, otherRate: 0.2 });
    expect(r?.high.label).toBe("graded 8.5-10.0");
  });

  it("both bands zero is nothing to claim", () => {
    expect(bandReturnFinding(summary([0, 0], [0, 0], [20, 0], [30, 0]))?.finding).toBeNull();
  });

  it("a small band is insufficient", () => {
    expect(
      bandReturnFinding(summary([0, 0], [0, 0], [20, 4], [3, 0]))?.finding,
    ).toEqual({ kind: "insufficient" });
  });
});
