import { describe, it, expect } from "vitest";
import type { Metric } from "web-vitals";
import { buildVitalEvent } from "../web-vitals";

// US-305: the metric → analytics payload mapping is the pure, testable core of
// the web-vitals reporter (the onLCP/onINP/etc. subscriptions need a real
// browser and are exercised only at runtime behind the consent gate).

function metric(partial: Partial<Metric> & Pick<Metric, "name" | "value">): Metric {
  return {
    rating: "good",
    delta: partial.value,
    id: "v1-123",
    navigationType: "navigate",
    entries: [],
    ...partial,
  } as Metric;
}

describe("buildVitalEvent (US-305)", () => {
  it("rounds time-based metrics to whole milliseconds", () => {
    expect(buildVitalEvent(metric({ name: "LCP", value: 2487.6 })).value).toBe(
      2488,
    );
    expect(buildVitalEvent(metric({ name: "INP", value: 142.2 })).value).toBe(
      142,
    );
    expect(buildVitalEvent(metric({ name: "TTFB", value: 88.9 })).value).toBe(
      89,
    );
  });

  it("scales CLS by 1000 to an integer (0.043 → 43)", () => {
    expect(buildVitalEvent(metric({ name: "CLS", value: 0.043 })).value).toBe(
      43,
    );
    expect(buildVitalEvent(metric({ name: "CLS", value: 0 })).value).toBe(0);
  });

  it("passes through rating, id, navigationType, and name", () => {
    const e = buildVitalEvent(
      metric({
        name: "LCP",
        value: 3200,
        rating: "needs-improvement",
        id: "v4-abc",
        navigationType: "reload",
      }),
    );
    expect(e).toEqual({
      name: "LCP",
      value: 3200,
      rating: "needs-improvement",
      id: "v4-abc",
      navigationType: "reload",
    });
  });
});
