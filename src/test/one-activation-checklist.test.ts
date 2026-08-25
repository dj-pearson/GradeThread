import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  activationStepsFor,
  activationProgress,
  EMPTY_ACTIVATION_STATE,
  type ActivationState,
} from "@/lib/activation-steps";

// US-2859. A new seller used to meet three different "get set up" lists whose
// first steps were "grade a garment", "grade your first garment" and "add your
// first source", each with its own progress query and its own dismissal. There
// was no answer to "how far through setup am I", because three components each
// had their own.
//
// One list now. This file holds that to be true in the two ways it can stop
// being true: a fourth list gets added, or a surface stops rendering from the
// shared one.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("the step list is one module (US-2859)", () => {
  it("the retired checklists are gone, not merely unused", () => {
    // Left on disk, either would still compile, still be importable, and still
    // be the obvious file to edit when somebody wants to change a step.
    for (const gone of [
      "src/components/flipdesk/flipdesk-onboarding.tsx",
      "src/stores/flipdesk-tour-store.ts",
    ]) {
      expect(existsSync(resolve(ROOT, gone)), `${gone} still exists`).toBe(false);
    }
  });

  it("no surface builds its own step list", () => {
    // The tell that a second list has appeared: a component that names more
    // than one activation destination itself instead of mapping over the
    // shared steps.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          files.push(relative(ROOT, p).replace(/\\/g, "/"));
        }
      }
    };
    walk(resolve(ROOT, "src/components/onboarding"));

    for (const f of files) {
      if (f.endsWith("onboarding-flow.tsx")) continue; // the tour, not a checklist
      const src = read(f);
      expect(
        /(?:steps|STEPS)\s*(?::[^=]*)?=\s*\[/.test(src),
        `${f} declares its own step array. Steps live in ` +
          "src/lib/activation-steps.ts so every surface shows the same list.",
      ).toBe(false);
    }
  });

  it("both surfaces render the one component", () => {
    // dashboard = the full list with progress; FlipDesk = the same list
    // filtered to what is left. A filter, not a second list.
    expect(read("src/pages/dashboard.tsx")).toContain("<ActivationChecklist />");
    const flipdesk = read("src/components/onboarding/flipdesk-activation.tsx");
    expect(flipdesk).toContain('<ActivationChecklist variant="remaining" />');
    expect(
      flipdesk.includes('pathname.startsWith("/dashboard/flipdesk")'),
      "the FlipDesk placement must still be scoped to FlipDesk — it is mounted " +
        "in the layout, so an unscoped render puts it on every page",
    ).toBe(true);
  });

  it("the dashboard no longer carries a second first-run card", () => {
    const dash = read("src/pages/dashboard.tsx");
    expect(
      dash.includes("firstRunFor"),
      "the persona first-run card is back. Its content is the buyer persona's " +
        "activation step now; a card beside the checklist naming a different " +
        "first action is the shape US-2859 removed.",
    ).toBe(false);
  });

  it("one dismissal, honoured by one hook", () => {
    const hook = read("src/hooks/use-activation.ts");
    expect(hook).toContain("gt.activation.dismissed");
    expect(hook).toContain("flipdesk_onboarded");
    // Nothing else may write the flag, or two surfaces can disagree about
    // whether the user is done.
    for (const f of [
      "src/components/onboarding/activation-checklist.tsx",
      "src/components/onboarding/flipdesk-activation.tsx",
      "src/pages/dashboard.tsx",
    ]) {
      // Comments stripped first. flipdesk-activation.tsx explains, in prose,
      // that the checklist it replaced wrote this flag — and a guard that
      // fires on the documentation written about it is a guard that punishes
      // writing any.
      const code = read(f)
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      expect(
        code.includes("flipdesk_onboarded"),
        `${f} writes the dismissal flag directly. It belongs to useActivation().`,
      ).toBe(false);
    }
  });
});

describe("the step list itself (US-2859)", () => {
  const personas = ["seller", "consignment", "developer", "buyer"] as const;

  it("every persona gets at least one step", () => {
    for (const p of personas) {
      expect(
        activationStepsFor(p, { notifications: true }).length,
        `${p} has no steps — the buyer persona used to be exactly this, which ` +
          "is why its guidance ended up in a bespoke card instead",
      ).toBeGreaterThan(0);
    }
    expect(activationStepsFor(null, { notifications: true }).length).toBeGreaterThan(0);
  });

  it("every step says why, not only what", () => {
    for (const p of [...personas, null]) {
      for (const step of activationStepsFor(p, { notifications: true })) {
        expect(step.reason.length, `${step.key} has no reason`).toBeGreaterThan(30);
        expect(step.reason.endsWith("."), `${step.key}: reason is not a sentence`).toBe(
          true,
        );
        expect(step.cta.length, `${step.key} has no CTA`).toBeGreaterThan(2);
      }
    }
  });

  it("a step without a route is handled somewhere, or it is a dead button", () => {
    // TWO steps have no `to`, and both are handled by name in
    // use-activation.ts's complete():
    //   notifications  asks the browser for permission, in place
    //   extension      US-2883: leaves the app for the web store, at a URL
    //                  resolved at runtime from the configured id
    // Any OTHER routeless step is a CTA that does nothing at all, which is the
    // failure this case exists to catch.
    const HANDLED_IN_PLACE = new Set(["notifications", "extension"]);
    const hook = readFileSync(
      resolve(process.cwd(), "src/hooks/use-activation.ts"),
      "utf8",
    );
    for (const p of [...personas, null]) {
      for (const step of activationStepsFor(p, { notifications: true })) {
        if (HANDLED_IN_PLACE.has(step.key)) {
          expect(step.to, `${step.key} completes in place`).toBeUndefined();
          // And the handler really is there, naming this step. Matched
          // loosely on purpose: notifications is written as a NEGATION
          // (`step.key !== "notifications"`) and extension as an equality, and
          // pinning either spelling would fail on a harmless rewrite. What
          // matters is that complete() mentions the step at all.
          const at = hook.indexOf("const complete = useCallback");
          expect(at, "complete() is gone from the hook").toBeGreaterThan(-1);
          const body = hook.slice(at);
          expect(
            body,
            `${step.key} has no route AND no branch in complete()`,
          ).toContain(`"${step.key}"`);
        } else {
          expect(step.to, `${step.key} has nowhere to go`).toBeTruthy();
        }
      }
    }
  });

  it("no step key repeats within a persona", () => {
    for (const p of [...personas, null]) {
      const keys = activationStepsFor(p, { notifications: true }).map((s) => s.key);
      expect(new Set(keys).size, `${p} repeats a step`).toBe(keys.length);
    }
  });

  it("the notifications step drops out where the browser cannot do them", () => {
    const withNotif = activationStepsFor("seller", { notifications: true });
    const without = activationStepsFor("seller", { notifications: false });
    expect(withNotif.some((s) => s.key === "notifications")).toBe(true);
    expect(without.some((s) => s.key === "notifications")).toBe(false);
    expect(without.length).toBe(withNotif.length - 1);
  });

  it("nothing reads as done on an empty account", () => {
    for (const p of [...personas, null]) {
      const steps = activationStepsFor(p, { notifications: true });
      const { done, firstIncomplete } = activationProgress(
        steps,
        EMPTY_ACTIVATION_STATE,
      );
      expect(done, `${p} shows progress on a brand-new account`).toBe(0);
      expect(firstIncomplete).toBe(0);
    }
  });

  it("progress is driven by real data, one field at a time", () => {
    const steps = activationStepsFor("seller", { notifications: true });
    const state: ActivationState = { ...EMPTY_ACTIVATION_STATE, gradeCount: 1 };
    expect(activationProgress(steps, state).done).toBe(1);
    expect(activationProgress(steps, { ...state, itemCount: 3 }).done).toBe(2);
    expect(
      activationProgress(steps, { ...state, itemCount: 3, sourceCount: 1 }).done,
    ).toBe(3);
    expect(
      activationProgress(steps, {
        ...state,
        itemCount: 3,
        sourceCount: 1,
        ebayConnected: true,
        notificationsGranted: true,
      }).firstIncomplete,
    ).toBe(-1);
  });
});
