import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTIVATION_FUNNEL_STEPS,
  ACTIVATION_SPLITS,
  BANNED_ACTIVATION_PROPS,
  activationEventName,
  activationStepIndex,
  takeFirstActivation,
  trackActivation,
} from "@/lib/activation-analytics";
import { activationStepsFor } from "@/lib/activation-steps";

// US-2884. "Where do new sellers stop" had no answer from data.
//
// WHAT THE STORY GETS WRONG, and it is the gap this closes rather than a
// quibble: it says "onboarding-flow fires onboarding.use_case_selected". It
// does NOT. That event is emitted from src/pages/signup.tsx and nowhere else,
// so a user who skipped the question at signup and answered it inside the tour
// emitted nothing at all.
//
// And US-2859's `onboarding.activation_step_started` records a BUTTON PRESS. A
// seller who opens the submission form and abandons it has pressed the button
// and activated nothing. Both events are kept -- the gap between pressed and
// completed is the abandonment rate for that step -- but only one of them
// answers the question the epic kept asking.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/\/?.*$/gm, "");

const LIB = "src/lib/activation-analytics.ts";
const HOOK = "src/hooks/use-activation.ts";
const FLOW = "src/components/onboarding/onboarding-flow.tsx";
const SWIFT = "ios/GradeThread/Telemetry/ActivationEvents.swift";
const NOTE = "vault/20-domain/activation-funnel.md";

beforeEach(() => {
  localStorage.clear();
});

describe("one registry declares the funnel (US-2884 AC1)", () => {
  it("the steps are ordered, and the order is data", () => {
    expect(ACTIVATION_FUNNEL_STEPS.length).toBeGreaterThan(8);
    // Index N downstream of N-1 is the whole reason a drop-off chart needs no
    // hand-maintained funnel definition in the PostHog UI.
    ACTIVATION_FUNNEL_STEPS.forEach((step, i) => {
      expect(activationStepIndex(step), `${step} is not at ${i}`).toBe(i);
    });
  });

  it("the story's named milestones are all in it", () => {
    for (const wanted of [
      "first_session",
      "tour_finished",
      "tour_skipped",
      "step_completed",
      "first_grade",
      "first_item",
      "marketplace_connected",
      "listing_published",
      "sale_reconciled",
    ]) {
      expect(ACTIVATION_FUNNEL_STEPS, `${wanted} is missing`).toContain(wanted);
    }
  });

  it("an exit is not a step", () => {
    // Putting a dismissal in the ordered list makes every drop-off chart count
    // giving up as progress.
    expect(ACTIVATION_FUNNEL_STEPS).not.toContain("checklist_dismissed");
    expect(activationStepIndex("checklist_dismissed")).toBe(-1);
  });

  it("the name is computed from the step, so renaming does both", () => {
    expect(activationEventName("first_grade")).toBe("activation_first_grade");
    expect(activationEventName("checklist_dismissed")).toBe(
      "activation_checklist_dismissed",
    );
  });

  it("the registry accepts the family and would reject a typo", () => {
    // A template-literal type, like the buyer funnel. Asserted on the source
    // because a typo is a COMPILE error -- there is nothing to catch at run
    // time, which is the point.
    const events = read("src/lib/analytics-events.ts");
    expect(events).toContain("ActivationEventName");
    expect(events).toContain(
      "`activation_${ActivationFunnelStep | ActivationFunnelExit}`",
    );
    expect(events).toContain("| ActivationEventName");
  });

  it("both clients emit from the one list", () => {
    const swift = read(SWIFT);
    for (const step of ACTIVATION_FUNNEL_STEPS) {
      expect(swift, `iOS cannot emit activation_${step}`).toContain(
        `= "activation_${step}"`,
      );
    }
    expect(swift).toContain('= "activation_checklist_dismissed"');
  });

  it("the Swift mirror is generated, not typed", () => {
    // Telemetry.event takes a raw String on iOS. A typo there is not an error:
    // PostHog accepts the event and the funnel shows iOS dropping to zero at
    // that step, which is invisible until somebody looks at the chart.
    const swift = read(SWIFT);
    expect(swift).toContain("scripts/generate-swift-mirrors.mjs");
    expect(swift).toContain("Do not hand-edit");
    const gen = read("scripts/generate-swift-mirrors.mjs");
    expect(gen).toContain("ACTIVATION_FUNNEL_STEPS");
  });

  it("iOS fixes its own platform property", () => {
    // A caller that could set it is a caller that could set it wrong, and the
    // split by platform is the whole reason the property exists.
    const swift = stripComments(read(SWIFT));
    expect(swift).toContain('"platform": "ios"');
    expect(swift).not.toContain("platform: String");
  });
});

describe("each step emits once, on completion (US-2884 AC2)", () => {
  it("a step fires the first time and never again", () => {
    const fired = trackActivation("first_grade", "u1", {
      persona: "seller",
      platform: "web",
    });
    expect(fired).toBe(true);
    expect(
      trackActivation("first_grade", "u1", { persona: "seller", platform: "web" }),
      "the same step fired twice for one account",
    ).toBe(false);
  });

  it("a different account still gets its own first", () => {
    trackActivation("first_grade", "u1", { persona: "seller", platform: "web" });
    expect(
      trackActivation("first_grade", "u2", { persona: "seller", platform: "web" }),
    ).toBe(true);
  });

  it("step_completed is once per STEP, not once per funnel position", () => {
    // The trap: one marker for the whole `step_completed` position would let
    // the first completed step silence the other eight.
    const p = { persona: "seller" as const, platform: "web" as const };
    expect(trackActivation("step_completed", "u1", { ...p, step: "grade" })).toBe(true);
    expect(trackActivation("step_completed", "u1", { ...p, step: "item" })).toBe(true);
    expect(trackActivation("step_completed", "u1", { ...p, step: "grade" })).toBe(false);
  });

  it("an anonymous caller emits nothing rather than everything", () => {
    expect(
      takeFirstActivation(undefined, "first_grade"),
      "a signed-out visitor would emit every step on every render",
    ).toBe(false);
  });

  it("the hook emits on isDone, not on the button press", () => {
    const hook = stripComments(read(HOOK));
    // The completion emit reads the step's own done-check.
    expect(hook).toMatch(/if \(!step\.isDone\(state\)\) continue;/);
    expect(hook).toContain('trackActivation("step_completed"');
    // And the older press event is still there: the gap between them is the
    // abandonment rate for that step.
    expect(hook).toContain("onboarding.activation_step_started");
  });

  it("the hook waits for the counts before burning the marker", () => {
    // EMPTY_ACTIVATION_STATE reads as "nothing done", so emitting while the
    // counts load would spend the once-only marker on an answer we do not
    // have yet.
    const hook = stripComments(read(HOOK));
    const at = hook.indexOf('trackActivation("step_completed"');
    expect(at).toBeGreaterThan(-1);
    const before = hook.slice(Math.max(0, at - 400), at);
    expect(before, "the emit does not wait for counts").toContain("if (!counts) return;");
  });

  it("the marker is not a ref, because the checklist renders twice", () => {
    // It is on the dashboard AND on FlipDesk. A per-mount ref would emit twice
    // for one account in one session.
    const lib = stripComments(read(LIB));
    expect(lib).toContain("localStorage.getItem(key)");
    expect(lib).toContain("localStorage.setItem(key");
  });

  it("storage failure means silence, not noise", () => {
    // Private mode / SSR. Emitting on every render is a worse failure than not
    // emitting: one is noise in the data, the other is a gap somebody notices.
    const lib = stripComments(read(LIB));
    const at = lib.indexOf("export function takeFirstActivation");
    const body = lib.slice(at, lib.indexOf("\n}", at));
    expect(body).toMatch(/catch \{[\s\S]*?return false;/);
  });
});

describe("the tour's endings are recorded (US-2884 AC1)", () => {
  const flow = stripComments(read(FLOW));

  it("finished and skipped are distinguishable", () => {
    // Before this they were not, and neither was distinguishable from "never
    // reached the tour".
    expect(flow).toContain('"onboarding.tour_finished"');
    expect(flow).toContain('"onboarding.tour_skipped"');
    expect(flow).toMatch(/routeNext \?\s*"onboarding\.tour_finished"/);
  });

  it("the persona is recorded when it is chosen in the tour", () => {
    // THE STORY SAYS onboarding-flow already fires this. It did not: the event
    // came from signup.tsx only, so a user who skipped the question at signup
    // and answered it here emitted nothing.
    expect(flow).toContain('track("onboarding.use_case_selected", { use_case: useCase, at: "tour" })');
    expect(flow).toContain('trackActivation("persona_chosen"');
  });

  it("signup still emits its own, with a different `at`", () => {
    // Two places choose a persona. The property is what tells them apart, and
    // dropping either would leave a hole in the funnel.
    // Matched on the WHOLE call. `at: "signup"` alone appears on three
    // different events in that file, so a bare toContain passed with the
    // persona event's property renamed.
    const signup = read("src/pages/signup.tsx");
    expect(signup).toContain(
      'track("onboarding.use_case_selected", { use_case: useCase, at: "signup" })',
    );
  });

  it("both new events are declared in the registry", () => {
    const events = read("src/lib/analytics-events.ts");
    expect(events).toContain('"onboarding.tour_finished"');
    expect(events).toContain('"onboarding.tour_skipped"');
  });
});

describe("the funnel is split the same way by everyone (US-2884 AC3)", () => {
  it("the splits are declared, not left to the chart author", () => {
    expect([...ACTIVATION_SPLITS]).toEqual(["persona", "platform"]);
  });

  it("every emit carries both", () => {
    const lib = stripComments(read(LIB));
    expect(lib).toContain("persona: UserUseCase | null");
    expect(lib).toContain('platform: ActivationPlatform');
    // And the index, so a chart needs no second source for the order.
    expect(lib).toContain("index: activationStepIndex(step)");
  });

  it("the note says plainly that no chart shipped", () => {
    // AC3 asked for a saved PostHog view or an admin page and got neither.
    // Saying so in the contract is the difference between a decision and a
    // thing somebody forgot.
    const note = read(NOTE);
    expect(note).toContain("What is NOT built");
    expect(note).toContain("funnel_metrics");
  });
});

describe("it is documented next to the contract (US-2884 AC4)", () => {
  it("the note exists and is a contract note", () => {
    expect(existsSync(resolve(ROOT, NOTE)), `${NOTE} is missing`).toBe(true);
    const note = read(NOTE);
    expect(note).toContain("type: contract");
    expect(note).toContain("source_of_truth: code");
  });

  it("it names the files it is a contract for", () => {
    // source_of_truth: code without code_refs is invisible to the drift guard.
    const note = read(NOTE);
    for (const ref of [
      "src/lib/activation-steps.ts",
      "src/lib/activation-analytics.ts",
      "ios/GradeThread/Telemetry/ActivationEvents.swift",
    ]) {
      expect(note, `${ref} is not a code_ref`).toContain(ref);
    }
  });

  it("it states the rename rule the AC asked for", () => {
    const note = read(NOTE);
    expect(note).toContain("Renaming a step renames its event");
  });

  it("the steps it documents are the steps that exist", () => {
    // A contract note that drifts from its own list is worse than none.
    const note = read(NOTE);
    for (const step of ACTIVATION_FUNNEL_STEPS) {
      expect(note, `the note does not mention ${step}`).toContain(step);
    }
    for (const persona of ["seller", "developer", "buyer"] as const) {
      for (const s of activationStepsFor(persona)) {
        expect(note, `the note does not mention the ${s.key} step`).toContain(s.key);
      }
    }
  });
});

describe("no personally identifying content, anywhere (US-2884 AC5)", () => {
  it("the banned list is real and blunt", () => {
    for (const banned of ["email", "name", "title", "brand", "price"]) {
      expect([...BANNED_ACTIVATION_PROPS], `${banned} is not banned`).toContain(banned);
    }
  });

  it("no declared property is a banned one", () => {
    const lib = stripComments(read(LIB));
    const at = lib.indexOf("export interface ActivationEventProps");
    expect(at).toBeGreaterThan(-1);
    const body = lib.slice(at, lib.indexOf("\n}", at));
    const declared = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(3);
    const offenders = declared.filter((d) =>
      (BANNED_ACTIVATION_PROPS as readonly string[]).includes(d),
    );
    expect(offenders, "an activation property carries content").toEqual([]);
  });

  it("no call site passes a banned property", () => {
    for (const f of [HOOK, FLOW]) {
      const src = stripComments(read(f));
      for (const m of src.matchAll(/trackActivation\([\s\S]{0,320}?\}\)/g)) {
        for (const banned of BANNED_ACTIVATION_PROPS) {
          expect(
            m[0].includes(`${banned}:`),
            `${f} passes "${banned}" to an activation event`,
          ).toBe(false);
        }
      }
    }
  });

  it("only opaque ids are allowed through", () => {
    const lib = stripComments(read(LIB));
    expect(lib).toContain("id?: string");
    // No free-text escape hatch: a Record<string, unknown> would let anything
    // through and make every assertion above decorative.
    expect(lib, "an untyped property bag would defeat the whole check").not.toContain(
      "Record<string, unknown>",
    );
  });

  it("iOS carries the same rule in the same shape", () => {
    const swift = stripComments(read(SWIFT));
    // persona / platform / step / index / id, and nothing else.
    for (const allowed of ["persona", "platform", "step", "index", "id"]) {
      expect(swift, `iOS lost the ${allowed} property`).toContain(allowed);
    }
    for (const banned of ["email", "title", "brand", "price"]) {
      expect(swift, `iOS sends "${banned}"`).not.toContain(`"${banned}"`);
    }
  });
});
