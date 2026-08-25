import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FLIPDESK_PLANS, type FlipdeskGateFlags } from "@/lib/constants";
import {
  GATE_FEATURE_COPY,
  PLAN_ORDER,
  explainGate,
  planIncludesFlag,
  requiredPlanForFlag,
} from "@/lib/plan-gates";

// US-2872.
//
// THE STORY READS AS A SWEEP AND IS ONE ENTRY PLUS ONE BUTTON. Measured before
// building, not after:
//   - sidebar.tsx has exactly ONE nav item with `requiresFlipdeskFlag`
//     (AutoLister), out of ten gate flags. The other nine gate things that are
//     not nav entries.
//   - of the four in-page plan gates, THREE already explain themselves:
//     api-keys.tsx renders a full upgrade card, radar.tsx has
//     NetworkUpgradeCard, reconciliation.tsx carries a lock badge naming the
//     plan. Only AutoLister's Generate button was `disabled={... || !entitled}`
//     with no reason given.
// So the fix is narrow, and the guard's job is mostly to stop the DISTINCTION
// between the three kinds of gate from being forgotten.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const SIDEBAR = "src/components/dashboard/sidebar.tsx";
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the required plan is derived, never written down (US-2872)", () => {
  it("every gate flag resolves to the cheapest plan that has it", () => {
    for (const flag of Object.keys(GATE_FEATURE_COPY) as Array<keyof FlipdeskGateFlags>) {
      const required = requiredPlanForFlag(flag);
      expect(required, `${flag} is in no plan at all`).not.toBeNull();
      // Nothing cheaper may already have it.
      const idx = PLAN_ORDER.indexOf(required!);
      for (const cheaper of PLAN_ORDER.slice(0, idx)) {
        expect(
          planIncludesFlag(cheaper, flag),
          `${flag}: ${cheaper} has it, so ${required} is not the cheapest`,
        ).toBe(false);
      }
      expect(planIncludesFlag(required!, flag)).toBe(true);
    }
  });

  it("the plan order matches the real plan table", () => {
    // Guards the guard: a reordered or renamed plan makes every "cheapest"
    // answer above wrong while still passing.
    expect([...PLAN_ORDER]).toEqual(["free", "starter", "pro", "business"]);
    for (const p of PLAN_ORDER) expect(FLIPDESK_PLANS[p]).toBeDefined();
  });

  it("AutoLister resolves to Pro, which is what the plan table says today", () => {
    const gate = explainGate("autolister");
    expect(gate).not.toBeNull();
    expect(gate!.requiredPlan).toBe("pro");
    expect(gate!.requiredPlanLabel).toBe("Pro");
  });

  it("no surface hardcodes a plan name next to a gate", () => {
    // A hardcoded "Pro" in an upgrade prompt goes stale the day a flag moves
    // tier, and it goes stale SILENTLY: the prompt still renders, pointing at
    // the wrong plan.
    const src = stripComments(read(SIDEBAR));
    expect(/requiredPlan: "(free|starter|pro|business)"/.test(src)).toBe(false);
  });
});

describe("every gated feature says what it DOES (US-2872 AC2)", () => {
  it("all ten flags have a sentence", () => {
    const flags = Object.keys(FLIPDESK_PLANS.free.gateFlags) as Array<
      keyof FlipdeskGateFlags
    >;
    expect(flags.length).toBeGreaterThan(5);
    for (const flag of flags) {
      const copy = GATE_FEATURE_COPY[flag];
      expect(copy, `${flag} has no explanation`).toBeTruthy();
      expect(copy.length, `${flag} explanation is too short to explain`).toBeGreaterThan(30);
      expect(copy.trim().endsWith("."), `${flag} is not a sentence`).toBe(true);
    }
  });

  it("the sentence says what it does, not what it costs", () => {
    // "Upgrade for AutoLister" is the hidden-feature problem wearing a lock
    // icon: the seller still does not know what they are being sold.
    for (const [flag, copy] of Object.entries(GATE_FEATURE_COPY)) {
      expect(
        /\bupgrade\b|\bplan\b|\bPro\b|\bBusiness\b|\$/.test(copy),
        `${flag}'s explanation talks about the plan instead of the feature`,
      ).toBe(false);
    }
  });

  it("no sentence just repeats the feature's own name", () => {
    expect(GATE_FEATURE_COPY.autolister.toLowerCase()).not.toContain("autolister");
    expect(GATE_FEATURE_COPY.reconciliation.toLowerCase()).not.toContain(
      "reconcil",
    );
  });
});

describe("three kinds of gate, and only one becomes visible (US-2872 AC1 + AC4)", () => {
  const src = read(SIDEBAR);
  const code = stripComments(src);

  it("a CAPABILITY gate still hides", () => {
    // AC4. A workspace member without permission is not a sales prospect:
    // they are someone the owner deliberately did not give this to. A locked
    // row would invite them to buy an upgrade that is not theirs to buy.
    expect(code).toContain("if (item.requires && !can(item.requires)) return false;");
  });

  it("the INVERSE tiering gate still hides", () => {
    // hiddenWhenFlipdeskFlag hides Reconcile once AutoLister supersedes it.
    // Rendering "Reconcile (locked)" to somebody who just paid for the better
    // tool is nonsense.
    expect(code).toMatch(/hiddenWhenFlipdeskFlag\]\s*\)\s*\{\s*return false;/);
  });

  it("a PLAN gate no longer hides", () => {
    const fn = code.slice(
      code.indexOf("function isItemVisible"),
      code.indexOf("function isItemLocked"),
    );
    expect(fn.length).toBeGreaterThan(50);
    expect(
      fn.includes("requiresFlipdeskFlag"),
      "isItemVisible still hides plan-gated items, which is the whole defect",
    ).toBe(false);
  });

  it("it becomes locked instead", () => {
    expect(code).toContain("function isItemLocked");
    expect(code).toMatch(/isItemLocked[\s\S]{0,200}requiresFlipdeskFlag/);
    expect(code).toContain("const locked = isItemLocked(item);");
  });
});

describe("the locked row is reachable and explains itself (US-2872 AC2)", () => {
  const code = stripComments(read(SIDEBAR));

  it("it is a button, not a disabled link", () => {
    // A disabled link is unfocusable and announces nothing, so the one user
    // who most needs the explanation -- navigating by keyboard or screen
    // reader -- is the one who cannot reach it.
    const block = code.slice(code.indexOf("const lockedRow ="), code.indexOf("if (lockedRow)"));
    expect(block).toContain('type="button"');
    expect(block).toContain("aria-label");
    expect(/disabled/.test(block), "the locked row is disabled and unreachable").toBe(
      false,
    );
  });

  it("it carries a lock glyph", () => {
    const block = code.slice(code.indexOf("const lockedRow ="), code.indexOf("if (lockedRow)"));
    // Two: the mobile row and the desktop row.
    expect((block.match(/<Lock\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("clicking it opens the upgrade dialog with the right plan", () => {
    const block = code.slice(code.indexOf("const lockedRow ="), code.indexOf("if (lockedRow)"));
    expect(block).toContain("showUpgrade({");
    expect(block).toContain("requiredPlan: gate.requiredPlan");
    expect(block).toContain('type: "feature"');
  });

  it("it says what the feature does, not only that it is locked", () => {
    const block = code.slice(code.indexOf("const lockedRow ="), code.indexOf("const link = ("));
    expect(block).toContain("gate.what");
  });

  it("it reuses the existing dialog rather than inventing a second one", () => {
    expect(code).toContain("useUpgradeDialogStore");
  });
});

describe("the in-page gate names a DERIVED plan (US-2872 AC3)", () => {
  const code = stripComments(read("src/pages/flipdesk/autolister.tsx"));

  // WHAT I FOUND ON THE WAY, and it changed the fix. The AutoLister page
  // ALREADY had a full upsell card (US-323) two elements above the disabled
  // Generate button: heading, sentence, and an "Upgrade to unlock" button. So
  // AC3's premise -- "gated in-page actions disable with no reason" -- was
  // weaker than it reads: the reason was on screen, just not on the button.
  //
  // My first fix added a second notice beside the button. That was REDUNDANT
  // with the card, and it pushed autolister.tsx over US-2520's line ceiling,
  // which is the ratchet doing exactly its job. Removed.
  //
  // What the card actually got wrong is the thing plan-gates.ts exists to
  // stop: it hardcoded "Pro" in the heading, "Pro or Business" in the body,
  // and requiredPlan: "pro" in the dialog call. All three go stale SILENTLY
  // the day the flag moves tier -- the card still renders, naming the wrong
  // plan at the moment of maximum intent.

  it("the card derives the plan name instead of writing it out", () => {
    expect(code).toContain('explainGate("autolister")');
    expect(code).toContain("autolisterGate?.requiredPlanLabel");
    expect(
      /AutoLister is a Pro feature/.test(code),
      "the heading hardcodes the plan name again",
    ).toBe(false);
    expect(
      /Upgrade to Pro or Business/.test(code),
      "the body hardcodes the plan names again",
    ).toBe(false);
  });

  it("the dialog it opens is handed a derived plan too", () => {
    expect(code).toContain("requiredPlan: autolisterGate?.requiredPlan");
  });

  it("the card says what the feature DOES, from the shared copy", () => {
    expect(code).toContain("autolisterGate?.what");
  });

  it("it only renders once billing has loaded", () => {
    // Otherwise every seller, paid or not, sees "you cannot use this" for the
    // moment the plan is unknown, which is worse than saying nothing.
    const at = code.indexOf("autolisterGate?.requiredPlanLabel");
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(Math.max(0, at - 600), at)).toContain("!billingLoading");
  });

  it("the three gates that already explained themselves were left alone", () => {
    // Measured, not assumed. Touching a working upgrade surface to make it
    // match a new pattern is churn with a regression risk and no user gain.
    expect(read("src/pages/api-keys.tsx")).toContain(
      "API Access Requires the Business Plan",
    );
    expect(read("src/pages/flipdesk/radar.tsx")).toContain("NetworkUpgradeCard");
    expect(read("src/pages/flipdesk/reconciliation.tsx")).toMatch(/<Lock\b/);
  });

  it("no second upsell was added beside the one that already worked", () => {
    // One gated surface, one explanation. Two is how they drift apart.
    expect(
      /PlanGateNotice/.test(code),
      "a second upsell sits beside the existing card",
    ).toBe(false);
  });
});
