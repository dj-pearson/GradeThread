// US-2109. The assertions here are about DATA INTEGRITY, not about whether a
// flag can be read — a broken read is obvious, whereas every failure mode below
// produces an experiment that runs, reports a number, and is wrong.

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  CONTROL,
  getAssignment,
  trackExposure,
  onFlagsReady,
  __resetExperimentsForTest,
} from "@/lib/client-experiments";

const KEY = "paywall_copy_v1";

function setPosthog(impl: Record<string, unknown> | undefined) {
  (window as unknown as { posthog?: unknown }).posthog = impl;
}

let captured: Array<[string, Record<string, unknown> | undefined]>;

beforeEach(() => {
  __resetExperimentsForTest();
  captured = [];
  setPosthog({
    capture: (e: string, p?: Record<string, unknown>) => captured.push([e, p]),
    getFeatureFlag: () => undefined,
  });
});

afterEach(() => {
  setPosthog(undefined);
  vi.restoreAllMocks();
});

describe("consent gating (AC2)", () => {
  it("returns control and is NOT ready when PostHog is absent", () => {
    // No consent → analytics.ts never initializes posthog-js → window.posthog
    // does not exist. There is no path that buckets this visitor.
    setPosthog(undefined);
    expect(getAssignment(KEY)).toEqual({ variant: CONTROL, ready: false });
  });

  it("records no exposure for an unconsented visitor", () => {
    setPosthog(undefined);
    const { variant } = getAssignment(KEY);
    trackExposure(KEY, variant);
    expect(captured).toEqual([]);
  });
});

describe("assignment resolution", () => {
  it("maps a multivariate string straight through", () => {
    setPosthog({ getFeatureFlag: () => "benefit_led", capture: () => {} });
    expect(getAssignment(KEY)).toEqual({ variant: "benefit_led", ready: true });
  });

  it("expresses a boolean flag as test/control so callers only branch on names", () => {
    setPosthog({ getFeatureFlag: () => true, capture: () => {} });
    expect(getAssignment(KEY).variant).toBe("test");
    __resetExperimentsForTest();
    setPosthog({ getFeatureFlag: () => false, capture: () => {} });
    expect(getAssignment(KEY).variant).toBe(CONTROL);
  });

  // The distinction the whole module rests on: "not delivered yet" must not
  // collapse into "control". If it did, every visitor would be counted into the
  // control arm during the load window and the experiment would read as a tie.
  it("keeps undefined (not delivered) separable from an actual control", () => {
    setPosthog({ getFeatureFlag: () => undefined, capture: () => {} });
    expect(getAssignment(KEY)).toEqual({ variant: CONTROL, ready: false });

    __resetExperimentsForTest();
    setPosthog({ getFeatureFlag: () => CONTROL, capture: () => {} });
    expect(getAssignment(KEY)).toEqual({ variant: CONTROL, ready: true });
  });

  it("never throws out into the UI when PostHog misbehaves", () => {
    setPosthog({
      getFeatureFlag: () => {
        throw new Error("posthog exploded");
      },
      capture: () => {},
    });
    expect(() => getAssignment(KEY)).not.toThrow();
    expect(getAssignment(KEY).ready).toBe(false);
  });
});

describe("no mid-session flips (property 2)", () => {
  it("locks the first resolved variant even if PostHog changes its answer", () => {
    let answer = "benefit_led";
    setPosthog({ getFeatureFlag: () => answer, capture: () => {} });
    expect(getAssignment(KEY).variant).toBe("benefit_led");

    // PostHog re-delivers flags (identify, payload refresh) with a new bucket.
    answer = "price_led";
    expect(getAssignment(KEY).variant).toBe("benefit_led");
  });

  it("does not let a late delivery overwrite a variant already shown", () => {
    setPosthog({ getFeatureFlag: () => "price_led", capture: () => {} });
    const first = getAssignment(KEY);
    trackExposure(KEY, first.variant);
    setPosthog({ getFeatureFlag: () => "benefit_led", capture: () => {} });
    expect(getAssignment(KEY).variant).toBe("price_led");
  });
});

describe("exposure is an event, not an evaluation (property 3)", () => {
  it("emits experiment_exposed once with the resolved variant", () => {
    setPosthog({
      getFeatureFlag: () => "benefit_led",
      capture: (e: string, p?: Record<string, unknown>) => captured.push([e, p]),
    });
    const { variant } = getAssignment(KEY);
    trackExposure(KEY, variant);
    expect(captured).toHaveLength(1);
    expect(captured[0]![0]).toBe("experiment_exposed");
    expect(captured[0]![1]).toMatchObject({
      experiment: KEY,
      variant: "benefit_led",
    });
  });

  it("is idempotent across remounts", () => {
    setPosthog({
      getFeatureFlag: () => "benefit_led",
      capture: (e: string, p?: Record<string, unknown>) => captured.push([e, p]),
    });
    const { variant } = getAssignment(KEY);
    trackExposure(KEY, variant);
    trackExposure(KEY, variant);
    trackExposure(KEY, variant);
    expect(captured).toHaveLength(1);
  });

  // An exposure fired before resolution lands in the arm the visitor is NOT in.
  it("refuses to record an exposure for an unresolved flag", () => {
    setPosthog({
      getFeatureFlag: () => undefined,
      capture: (e: string, p?: Record<string, unknown>) => captured.push([e, p]),
    });
    getAssignment(KEY);
    trackExposure(KEY, CONTROL);
    expect(captured).toEqual([]);
  });
});

describe("flag-delivery subscription", () => {
  it("returns PostHog's unsubscribe when it provides one", () => {
    const off = vi.fn();
    setPosthog({ onFeatureFlags: () => off, capture: () => {} });
    const unsub = onFlagsReady(() => {});
    unsub();
    expect(off).toHaveBeenCalled();
  });

  it("returns a safe no-op when PostHog is absent", () => {
    setPosthog(undefined);
    expect(() => onFlagsReady(() => {})()).not.toThrow();
  });
});
