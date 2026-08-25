import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMPTY_ACTIVATION_STATE,
  activationStepsFor,
  type ActivationState,
} from "@/lib/activation-steps";
import {
  GUIDED_PATH_KEYS,
  guidedStepsFor,
  isGuidedPathComplete,
  nextGuidedStep,
} from "@/lib/guided-path";

// US-2873.
//
// AC5 IS THE DESIGN CONSTRAINT, not a footnote: "rather than being a fifth
// parallel checklist". US-2859 spent a whole story collapsing FOUR overlapping
// first-run lists into activation-steps.ts, and what it fixed was three lists
// with three different first steps, three progress queries and three
// dismissals -- so there was no answer to "how far through setup am I".
//
// A guided path with its own sequence would be the fifth. So this one adds no
// steps and no progress state: it is a FILTER and an ORDERING over the steps
// that already exist, and every question it answers comes from the same
// ActivationState the checklist reads. Most of this file exists to keep it
// that way.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const OPTS = { notifications: false };

describe("the path is a filter over the real steps (US-2873 AC5)", () => {
  it("declares no steps of its own", () => {
    // The whole point. A literal step object in this file is a fifth list.
    const code = stripComments(read("src/lib/guided-path.ts"));
    expect(
      /title:\s*["'`]/.test(code),
      "guided-path.ts declares a step title, which means it has started being " +
        "a second list of steps instead of a view onto the real one",
    ).toBe(false);
    expect(/reason:\s*["'`]/.test(code)).toBe(false);
    expect(/isDone:\s*\(/.test(code)).toBe(false);
    expect(code).toContain("activationStepsFor(");
  });

  it("every path step is a real activation step for that persona", () => {
    for (const useCase of ["seller", "consignment", "developer", "buyer", null] as const) {
      const all = activationStepsFor(useCase, OPTS);
      for (const step of guidedStepsFor(useCase, OPTS)) {
        expect(
          all.some((a) => a.key === step.key),
          `${useCase}: the path offers ${step.key}, which is not one of this ` +
            "persona's activation steps",
        ).toBe(true);
      }
    }
  });

  it("it keeps the persona's own ordering", () => {
    const all = activationStepsFor("seller", OPTS).map((s) => s.key);
    const path = guidedStepsFor("seller", OPTS).map((s) => s.key);
    const expected = all.filter((k) => GUIDED_PATH_KEYS.includes(k));
    expect(path).toEqual(expected);
  });

  it("a persona with no first listing gets no path", () => {
    // A buyer's only step is Scan. Walking them through publishing a listing
    // would be walking them through somebody else's product.
    expect(guidedStepsFor("buyer", OPTS)).toEqual([]);
    expect(nextGuidedStep("buyer", EMPTY_ACTIVATION_STATE, OPTS)).toBeNull();
  });

  it("the path is the photo-to-published subset, not the whole checklist", () => {
    const path = guidedStepsFor("seller", OPTS).map((s) => s.key);
    expect(path).toContain("grade");
    expect(path).toContain("item");
    // `source` is real bookkeeping and belongs on the checklist; a guided walk
    // that detours through it turns a five-minute promise into a chore.
    expect(path).not.toContain("source");
    expect(path).not.toContain("notifications");
  });
});

describe("resume needs no bookmark (US-2873 AC3)", () => {
  const seller = (over: Partial<ActivationState> = {}): ActivationState => ({
    ...EMPTY_ACTIVATION_STATE,
    ...over,
  });

  it("a brand-new account starts at step 1", () => {
    const pos = nextGuidedStep("seller", seller(), OPTS);
    expect(pos).not.toBeNull();
    expect(pos!.index).toBe(1);
    expect(pos!.step.key).toBe("grade");
  });

  it("coming back mid-way resumes at the first UNDONE step", () => {
    // No cursor is stored anywhere, so this cannot disagree with the account.
    const pos = nextGuidedStep("seller", seller({ gradeCount: 1 }), OPTS);
    expect(pos!.step.key).toBe("item");
    expect(pos!.index).toBe(2);
  });

  it("progress made OUTSIDE the walkthrough still counts", () => {
    // The seller left, added an item by hand, and came back. A path with its
    // own cursor would send them to do it again.
    const pos = nextGuidedStep("seller", seller({ gradeCount: 2, itemCount: 5 }), OPTS);
    expect(pos!.step.key).toBe("ebay");
  });

  it("it ends by being finished, not by being marked finished", () => {
    const done = seller({ gradeCount: 1, itemCount: 1, ebayConnected: true });
    expect(nextGuidedStep("seller", done, OPTS)).toBeNull();
    expect(isGuidedPathComplete("seller", done, OPTS)).toBe(true);
  });

  it("nothing reads as complete on an empty state", () => {
    // The loading case. A path that congratulates a new seller for finishing
    // before their counts arrive is worse than one that flashes.
    expect(isGuidedPathComplete("seller", EMPTY_ACTIVATION_STATE, OPTS)).toBe(false);
  });

  it("a persona with NO path is not 'complete', it is absent", () => {
    // [].every() is true, so without the length check a buyer -- who has no
    // first-listing path at all -- reads as having finished one. The seller
    // case above cannot catch this: it has steps, and none of them are done
    // either way. A sabotage removing the length check survived on exactly
    // that gap.
    expect(guidedStepsFor("buyer", OPTS)).toEqual([]);
    expect(isGuidedPathComplete("buyer", EMPTY_ACTIVATION_STATE, OPTS)).toBe(false);
  });

  it("the step count is the path's, not the checklist's", () => {
    const pos = nextGuidedStep("seller", seller(), OPTS);
    expect(pos!.total).toBe(guidedStepsFor("seller", OPTS).length);
    expect(pos!.total).toBeLessThan(activationStepsFor("seller", OPTS).length);
  });
});

describe("the bar shows ONE instruction (US-2873 AC2)", () => {
  const src = read("src/components/onboarding/guided-path-bar.tsx");
  const code = stripComments(src);

  it("it renders a single step, never a list", () => {
    // The difference between this and the checklist.
    expect(
      /\.map\(/.test(code),
      "the guided bar maps over something, which means it is rendering a list",
    ).toBe(false);
    expect(code).toContain("nextGuidedStep(");
  });

  it("it shows the instruction, the reason and the position", () => {
    expect(code).toContain("{step.title}");
    expect(code).toContain("{step.reason}");
    expect(code).toMatch(/Step \{index\} of \{total\}/);
  });

  it("the copy comes from activation-steps, not rewritten here", () => {
    // Two copies of "why this matters" is how they end up disagreeing.
    const jsxText = code.match(/>[^<>{}]{25,}</g);
    expect(
      jsxText,
      `the bar writes its own copy: ${jsxText?.join(" / ")}`,
    ).toBeNull();
  });

  it("leaving is one click and keeps the work", () => {
    expect(code).toContain("Leave the walkthrough");
    expect(code).toContain("setGuidedPathOptOut");
    // AC3: there is no cursor to discard, so leaving cannot lose progress.
    expect(/clear|reset|delete/i.test(code.split("setGuidedPathOptOut")[1] ?? "")).toBe(
      false,
    );
  });
});

describe("it is offered and replayable from the right places (AC1 + AC4)", () => {
  it("the offer sits on the activation checklist", () => {
    const code = stripComments(read("src/components/onboarding/activation-checklist.tsx"));
    expect(code).toContain("Walk me through it");
    expect(code).toContain("startGuided(");
    // Only while there is something left to walk.
    expect(code).toMatch(/firstIncomplete !== -1/);
  });

  it("Help can replay it", () => {
    const code = stripComments(read("src/pages/help-reader.tsx"));
    expect(code).toContain("Walk me through my first listing");
    expect(code).toContain("startGuided(");
  });

  it("replaying clears the opt-out, or it would do nothing", () => {
    const code = stripComments(read("src/stores/guided-path-store.ts"));
    // The IMPLEMENTATION, not the interface declaration above it -- the
    // first "start:" in the file is the type, and slicing from there found
    // no code at all while still looking like a real assertion.
    const impl = code.slice(code.indexOf("start: (userId)"));
    const start = impl.slice(0, impl.indexOf("stop:"));
    expect(start).toContain("setGuidedPathOptOut(userId, false)");
  });

  it("the bar renders above every dashboard screen, once", () => {
    const code = stripComments(read("src/layouts/dashboard-layout.tsx"));
    expect((code.match(/<GuidedPathBar/g) ?? []).length).toBe(1);
  });

  it("the store holds no progress of its own", () => {
    // If it ever does, it can disagree with the account -- which is the exact
    // failure US-2859 removed.
    const code = stripComments(read("src/stores/guided-path-store.ts"));
    for (const forbidden of ["currentStep", "stepIndex", "progress", "completed"]) {
      expect(
        code.includes(forbidden),
        `the guided-path store tracks ${forbidden}; progress must come from ` +
          "ActivationState so it cannot fall out of step with real data",
      ).toBe(false);
    }
  });
});
