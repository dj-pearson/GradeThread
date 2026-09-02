import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  activationStepsFor,
  activationProgress,
  EMPTY_ACTIVATION_STATE,
  type ActivationState,
} from "@/lib/activation-steps";

// US-2883. Buyer onboarding was a separate page with a separate pattern.
//
// WHAT THE STORY GOT RIGHT AND WHAT HAD ALREADY MOVED:
//
//   "stepsFor returns an empty array for 'buyer'" was TRUE WHEN FILED and was
//   already false by the time this ran -- US-2859, earlier in this same epic,
//   added `case "buyer": return [SCAN]`. So AC1 read as done.
//
//   It was not done. That single step was written `isDone: () => false` -- a
//   step nobody can ever complete. And it sat beside
//   components/buyer/buyer-first-steps.tsx, a SECOND 204-line checklist with
//   three real steps, its own count queries and its own localStorage
//   dismissal. US-2859 removed exactly that duplication on the seller side and
//   did not know this file existed.
//
// So the buyer had TWO checklists that disagreed, one of which could never
// finish. That is the thing this story actually fixed.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/\/?.*$/gm, "");

const LIB = "src/lib/activation-steps.ts";
const HOOK = "src/hooks/use-activation.ts";
const CHECKLIST = "src/components/onboarding/activation-checklist.tsx";
const BUYER_HOME = "src/pages/buyer/home.tsx";
// US-3075: the grading overview renders its widgets from this registry.
const REGISTRY = "src/lib/dashboard-widgets.ts";

describe("the buyer is a persona in the shared module (US-2883 AC1)", () => {
  const steps = activationStepsFor("buyer");

  it("the buyer has a real list, not an empty one", () => {
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.map((s) => s.key)).toEqual(["extension", "alert", "closet"]);
  });

  it("every buyer step can actually finish", () => {
    // The whole point. A permanently-lit step tells a buyer who has done
    // everything that they have done nothing.
    const allDone: ActivationState = {
      ...EMPTY_ACTIVATION_STATE,
      alertCount: 1,
      closetCount: 1,
      extensionInstalled: true,
    };
    const { done, total } = activationProgress(steps, allDone);
    expect(done, "a buyer who has done all three is not shown as finished").toBe(total);
  });

  it("no step anywhere is written un-completable", () => {
    // Comments stripped: the note above the buyer steps quotes this string
    // while explaining why it is banned.
    expect(stripComments(read(LIB))).not.toContain("isDone: () => false");
  });

  it("each step is done on a real signal, one per step", () => {
    const none = activationProgress(steps, EMPTY_ACTIVATION_STATE);
    expect(none.done).toBe(0);
    for (const [key, state] of [
      ["extension", { ...EMPTY_ACTIVATION_STATE, extensionInstalled: true }],
      ["alert", { ...EMPTY_ACTIVATION_STATE, alertCount: 3 }],
      ["closet", { ...EMPTY_ACTIVATION_STATE, closetCount: 1 }],
    ] as const) {
      const p = activationProgress(steps, state);
      expect(p.done, `${key} did not complete on its own signal`).toBe(1);
    }
  });

  it("the buyer list carries no notifications step", () => {
    // The alert step already asks for the only notification a buyer has a
    // reason to want. Asking twice in one list reads as the list not knowing
    // what it already said.
    expect(steps.map((s) => s.key)).not.toContain("notifications");
  });

  it("the seller list is untouched", () => {
    const seller = activationStepsFor("seller").map((s) => s.key);
    expect(seller.slice(0, 4)).toEqual(["grade", "item", "source", "ebay"]);
    for (const buyerKey of ["extension", "alert", "closet"]) {
      expect(seller, `the seller list picked up ${buyerKey}`).not.toContain(buyerKey);
    }
  });
});

describe("the shell decides which list applies (US-2883 AC2)", () => {
  it("the hook takes a persona override", () => {
    const hook = stripComments(read(HOOK));
    expect(hook).toContain("personaOverride?: UserUseCase");
    expect(hook).toContain("const useCase = personaOverride ?? profile?.use_case ?? null");
  });

  it("the checklist passes it through", () => {
    const c = stripComments(read(CHECKLIST));
    expect(c).toContain("persona?: UserUseCase");
    expect(c).toContain("useActivation(persona)");
  });

  it("the buyer home names the persona; the seller surfaces do not", () => {
    expect(stripComments(read(BUYER_HOME))).toContain(
      '<ActivationChecklist persona="buyer" />',
    );
    // The dashboard gets the profile's own persona, so a buyer-first account
    // that starts selling is not shown seller steps before it has a use case.
    // US-3075: the grading overview renders from the widget registry, which
    // loads the component and hands it only `size` and `surface`. There is no
    // props site there to hardcode a persona INTO, which is a stronger form
    // of the same guarantee than the one this used to read off the page.
    const registry = stripComments(read(REGISTRY));
    expect(registry).toContain("m.ActivationChecklist");
    expect(registry, "the seller dashboard hardcodes a persona").not.toContain(
      "ActivationChecklist persona=",
    );
  });

  it("a dual-role account never meets two lists on one page", () => {
    // Structural: one component, one persona per render site. A page that
    // rendered both would have to name both.
    const buyer = stripComments(read(BUYER_HOME));
    const buyerCount = (buyer.match(/<ActivationChecklist/g) ?? []).length;
    expect(
      buyerCount,
      `${BUYER_HOME} renders the checklist ${buyerCount} times`,
    ).toBe(1);

    // The grading board can only carry it once: a layout is a set of widget
    // ids and normalize() drops a repeat. One registry entry is the whole
    // claim.
    const registry = stripComments(read(REGISTRY));
    const registered = (registry.match(/m\.ActivationChecklist/g) ?? []).length;
    expect(registered, `the registry loads it ${registered} times`).toBe(1);
    expect(stripComments(read("src/pages/dashboard.tsx"))).not.toContain(
      "<ActivationChecklist",
    );
  });
});

describe("the buyer shell renders the shared component (US-2883 AC3)", () => {
  it("the second checklist is gone, not merely unused", () => {
    expect(
      existsSync(resolve(ROOT, "src/components/buyer/buyer-first-steps.tsx")),
      "buyer-first-steps.tsx is back. It was a second step list with its own " +
        "queries and its own dismissal.",
    ).toBe(false);
  });

  it("nothing references it any more", () => {
    for (const f of [BUYER_HOME, CHECKLIST]) {
      expect(stripComments(read(f)), `${f} still imports BuyerFirstSteps`).not.toContain(
        "BuyerFirstSteps",
      );
    }
  });

  it("the buyer's counts run through the one hook", () => {
    const hook = stripComments(read(HOOK));
    expect(hook).toContain('head("saved_searches")');
    expect(hook).toContain('head("closet_items")');
    // And only for a persona whose steps read them -- a seller must not pay
    // for two head-counts they will never see.
    expect(hook).toContain('stepKeys.has("alert")');
    expect(hook).toContain('stepKeys.has("closet")');
  });

  it("the checklist disappears once every step is done", () => {
    // BuyerFirstSteps did this and the shared component did not: variant
    // "full" showed finished steps struck through, so adopting it without
    // this would have left a completed buyer with a permanent card.
    expect(stripComments(read(CHECKLIST))).toContain(
      "if (remaining.length === 0) return null",
    );
  });
});

describe("switching shells does not restart anything (US-2883 AC4)", () => {
  const hook = stripComments(read(HOOK));

  it("the dismissal is keyed per persona", () => {
    expect(hook).toContain("gt.activation.dismissed.buyer");
    expect(hook).toContain("useCase: UserUseCase | null");
  });

  it("a buyer dismissal never writes the seller column", () => {
    // `users.flipdesk_onboarded` is a SELLER flag. Writing it when a buyer
    // dismisses the buyer card would hide the seller checklist too, and every
    // seller can shop (US-1887) -- so that is not a hypothetical account.
    const at = hook.indexOf("const dismiss = useCallback");
    expect(at).toBeGreaterThan(-1);
    const body = hook.slice(at, hook.indexOf("const undismiss", at));
    const guardAt = body.indexOf('if (useCase === "buyer") return;');
    const writeAt = body.indexOf("flipdesk_onboarded: true");
    expect(guardAt, "no buyer guard before the seller column write").toBeGreaterThan(-1);
    expect(guardAt, "the guard runs after the write").toBeLessThan(writeAt);
  });

  it("the seller column does not silence the buyer list", () => {
    // The reverse direction, and the one that would have bitten most users: a
    // dual-role seller who dismissed the seller checklist has said nothing
    // about the buyer one.
    expect(hook).toContain('(useCase === "buyer" || !profile.flipdesk_onboarded)');
  });

  it("the seller dismissal key is unchanged", () => {
    // Renaming it would have un-dismissed every existing seller at once.
    expect(hook).toContain('`gt.activation.dismissed:${who}`');
  });

  it("nothing in the checklist writes a completion flag on render", () => {
    // "Switching to buying does not restart onboarding" fails the other way
    // too: a shell that stamped a flag on mount would re-run the buyer
    // preferences page for a seller who wandered in.
    const c = stripComments(read(CHECKLIST));
    expect(c).not.toContain("onboarding_completed_at");
    expect(c).not.toContain("flipdesk_onboarded");
  });

  it("the buyer preferences page is still what /buyer/onboarding is", () => {
    // Recorded because the story calls it "onboarding" and it is not a tour:
    // it collects categories, brands and sizes so recommendations work. It is
    // a form, and merging it into a checklist would have thrown that away.
    const page = read("src/pages/buyer/onboarding.tsx");
    expect(page).toContain("useBuyerPreferences");
    expect(page).toContain("onboarding_completed_at");
    const home = read(BUYER_HOME);
    expect(home).toContain('<Navigate to="/buyer/onboarding" replace />');
  });
});

describe("the extension step is not a dead button", () => {
  const hook = stripComments(read(HOOK));

  it("it opens the web store, because the step has no route", () => {
    // Only two steps have no `to`: notifications, which asks the browser, and
    // this one, which leaves the app. Without its own branch the CTA would
    // fall through and do nothing at all.
    expect(hook).toContain('if (step.key === "extension")');
    expect(hook).toContain("extensionWebStoreUrl()");
    expect(hook).toContain('window.open(url, "_blank", "noopener,noreferrer")');
  });

  it("settings is the fallback, never the first answer", () => {
    const at = hook.indexOf('if (step.key === "extension")');
    const body = hook.slice(at, at + 600);
    const openAt = body.indexOf("window.open");
    const fallbackAt = body.indexOf('navigate("/buyer/settings")');
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(openAt, "settings is tried before the store").toBeLessThan(fallbackAt);
  });

  it("the install check survives a late content script", () => {
    expect(hook).toContain("setExtensionInstalled(isExtensionInstalled())");
    expect(hook).toMatch(/setTimeout\(\(\) => setExtensionInstalled/);
  });
});
