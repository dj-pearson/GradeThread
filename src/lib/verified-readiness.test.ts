import { describe, it, expect } from "vitest";
import { readinessSteps } from "@/lib/verified-readiness";

describe("readinessSteps (V13)", () => {
  it("handle and bio set, private, nothing graded: 2 of 6", () => {
    const steps = readinessSteps({
      handle: "alpha",
      bio: "Denim.",
      enabled: false,
      embedInListings: true,
      graded: 0,
      badgeClicks: 0,
    });
    expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual(["handle", "bio"]);
  });

  it("credentials only count while the profile is public", () => {
    const base = { handle: "alpha", bio: null, embedInListings: true, graded: 1, badgeClicks: 3 };
    const off = readinessSteps({ ...base, enabled: false });
    const on = readinessSteps({ ...base, enabled: true });
    expect(off.find((s) => s.id === "listings")?.done).toBe(false);
    expect(on.find((s) => s.id === "listings")?.done).toBe(true);
    expect(on.filter((s) => s.done)).toHaveLength(5);
  });
});
