import { describe, it, expect } from "vitest";
import {
  CALCULATORS,
  calculatorHandoff,
  liveCalculators,
} from "../calculators";
import { FLIPDESK_LANDINGS } from "../flipdesk-landing";
import { ANALYTICS_EVENTS } from "@/lib/analytics-events";

// US-9010. The calculator-to-FlipDesk funnel is four events and eight
// handoffs, and every one of them is a string that can go stale silently: a
// renamed landing slug leaves a dead link, a missing handoff throws at render
// on a page a crawler already indexed.

describe("every live calculator hands off somewhere real", () => {
  const live = liveCalculators();

  it("has all eight calculators live", () => {
    expect(live).toHaveLength(8);
    expect(CALCULATORS).toHaveLength(8);
  });

  it("gives every live calculator a handoff", () => {
    for (const calc of live) {
      expect(() => calculatorHandoff(calc), calc.slug).not.toThrow();
    }
  });

  it("points every handoff at a FlipDesk landing that exists", () => {
    const slugs = new Set(FLIPDESK_LANDINGS.map((l) => l.slug));
    for (const calc of live) {
      const { surface } = calculatorHandoff(calc);
      expect(slugs.has(surface), `${calc.slug} -> /flipdesk/${surface}`).toBe(true);
    }
  });

  it("matches the handoff to the calculator rather than sending everyone to one page", () => {
    // If every calculator pointed at the same surface, the handoff would be an
    // advert rather than a next step, and the per-slug conversion rate the
    // story asks for would have nothing to distinguish.
    const surfaces = new Set(live.map((c) => calculatorHandoff(c).surface));
    expect(surfaces.size).toBeGreaterThanOrEqual(3);
  });

  it("writes handoff copy, not placeholder copy", () => {
    for (const calc of live) {
      const h = calculatorHandoff(calc);
      expect(h.heading.length, calc.slug).toBeGreaterThan(15);
      expect(h.body.length, calc.slug).toBeGreaterThan(120);
      expect(h.cta.length, calc.slug).toBeGreaterThan(8);
    }
  });
});

describe("the funnel events are declared", () => {
  it("declares all four steps", () => {
    for (const name of [
      "calculator_view",
      "calculator_used",
      "calculator_cta_clicked",
      "signup_started_from_tool",
    ]) {
      expect(name in ANALYTICS_EVENTS, name).toBe(true);
    }
  });

  it("keeps a view event, which is the denominator the story needs", () => {
    // The story asks "acquisition channel, or just traffic". That is a rate,
    // and a rate needs the count of arrivals, not only the count of clicks.
    expect(ANALYTICS_EVENTS.calculator_view).toMatch(/loaded/i);
  });
});
