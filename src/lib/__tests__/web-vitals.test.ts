import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Metric } from "web-vitals";
import {
  __resetWebVitalsForTest,
  buildVitalEvent,
  startWebVitals,
} from "../web-vitals";

// Records which metrics were subscribed, in order. Declared before vi.mock
// because the factory is hoisted above the imports and closes over it.
const subscriptions: string[] = [];

vi.mock("web-vitals", () => {
  const fire = (name: string) => (handler: (m: Metric) => void) => {
    subscriptions.push(name);
    handler({
      name,
      value: name === "CLS" ? 0.05 : 1234.5,
      rating: "good",
      id: `v1-${name}`,
      navigationType: "navigate",
    } as unknown as Metric);
  };
  return {
    onLCP: fire("LCP"),
    onINP: fire("INP"),
    onCLS: fire("CLS"),
    onTTFB: fire("TTFB"),
  };
});

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

// US-2440: startWebVitals itself — the half the reset hatch was written for and
// the half nothing ran. The tests above cover buildVitalEvent only.
//
// vitest.config.ts aliases `web-vitals` to a NO-OP stub (src/test/stubs), because
// the real library arms timers that outlive a test file and crash the run after
// jsdom teardown. A no-op stub means the four subscriptions never call back, so
// with the alias alone there is nothing to observe here. vi.mock takes precedence
// over resolve.alias, so this file supplies its own synchronous stand-in: it
// invokes the handler immediately and arms no timers, which keeps the flake the
// real stub exists to prevent while making the wiring observable.
describe("startWebVitals (US-2440)", () => {
  beforeEach(() => {
    __resetWebVitalsForTest();
    subscriptions.length = 0;
  });

  afterEach(() => {
    __resetWebVitalsForTest();
  });

  it("subscribes all four metrics and reports through the injected sink", async () => {
    const report = vi.fn();
    await startWebVitals(report);

    // All four, not a sample: LCP/INP/CLS/TTFB are the set the March 2026 core
    // update weights, and a missing subscription is silent — the metric simply
    // never appears in analytics.
    expect(subscriptions).toEqual(["LCP", "INP", "CLS", "TTFB"]);
    // And the payload is the BUILT event, not the raw Metric: the injected sink
    // exists so a caller can receive the analytics shape.
    expect(report).toHaveBeenCalledTimes(4);
    expect(report.mock.calls[0]![0]).toMatchObject({
      name: "LCP",
      rating: "good",
      navigationType: "navigate",
    });
  });

  it("is a ONCE guard — a second call subscribes nothing", async () => {
    // THE REASON THE HATCH EXISTS. startWebVitals is called from startAnalytics,
    // which runs whenever consent is granted; without the guard a visitor who
    // re-opens the banner would double-subscribe and every metric would be
    // reported twice, quietly doubling the numbers rather than failing.
    await startWebVitals(vi.fn());
    expect(subscriptions).toHaveLength(4);

    const second = vi.fn();
    await startWebVitals(second);
    expect(subscriptions).toHaveLength(4);
    expect(second).not.toHaveBeenCalled();
  });

  it("the reset hatch genuinely re-arms the guard", async () => {
    // AC2/AC3: this is the case that proves the hatch does what every other case
    // here assumes. Without it the guard could not be exercised twice in one
    // process, which is why it was written and why it looked like dead code.
    await startWebVitals(vi.fn());
    expect(subscriptions).toHaveLength(4);

    __resetWebVitalsForTest();
    subscriptions.length = 0;

    const third = vi.fn();
    await startWebVitals(third);
    expect(subscriptions).toEqual(["LCP", "INP", "CLS", "TTFB"]);
    expect(third).toHaveBeenCalledTimes(4);
  });
});
