// US-2701: the web's cadence choices must be ones the EXTENSION accepts.
//
// POLL_INTERVAL_CHOICES is a second copy of a bounded set, and this codebase has
// been bitten by that shape more than once — EXTENSION_DELIST_PLATFORMS drifted
// from its hand-written twin and the consequence was the oversell the module
// existed to prevent.
//
// Here the drift is quieter and still bad: the page offers "every 15 minutes",
// the seller picks it, the extension clamps it to 30, and nothing anywhere says
// so. The seller believes they configured something they did not.
//
// So this reads the SHIPPED extension module rather than a copy of its numbers.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { POLL_INTERVAL_CHOICES } from "@/hooks/use-sold-sync";

interface PollPlan {
  MIN_INTERVAL_MIN: number;
  MAX_INTERVAL_MIN: number;
  DEFAULT_INTERVAL_MIN: number;
  normalizeIntervalMin: (raw: unknown) => number;
}

function loadPollPlan(): PollPlan {
  const path = resolve(process.cwd(), "extension-unified/sync/poll-plan.js");
  const src = readFileSync(path, "utf8");
  const scope: Record<string, unknown> = {};
  new Function("self", `${src}; return self.GT_SYNC_POLL;`)(scope);
  return scope.GT_SYNC_POLL as unknown as PollPlan;
}

describe("web cadence choices match the extension's planner", () => {
  const plan = loadPollPlan();

  it("every choice the page offers survives the planner unchanged", () => {
    for (const minutes of POLL_INTERVAL_CHOICES) {
      expect(
        plan.normalizeIntervalMin(minutes),
        `the page offers ${minutes} minutes but the extension clamps it — the ` +
          `seller would pick one cadence and silently get another`,
      ).toBe(minutes);
    }
  });

  it("the choices stay inside the planner's band", () => {
    for (const minutes of POLL_INTERVAL_CHOICES) {
      expect(minutes).toBeGreaterThanOrEqual(plan.MIN_INTERVAL_MIN);
      expect(minutes).toBeLessThanOrEqual(plan.MAX_INTERVAL_MIN);
    }
  });

  it("the planner's default is one of the offered choices", () => {
    // Otherwise the control renders with no option selected the first time a
    // seller opens it, and changing anything else silently moves their cadence.
    expect([...POLL_INTERVAL_CHOICES]).toContain(plan.DEFAULT_INTERVAL_MIN);
  });

  it("the parity check can actually fail", () => {
    // Proven rather than assumed: four source-scan guards in this feature passed
    // against sabotaged code before being scoped correctly.
    expect(plan.normalizeIntervalMin(15)).not.toBe(15);
    expect(plan.normalizeIntervalMin(99999)).not.toBe(99999);
  });
});
