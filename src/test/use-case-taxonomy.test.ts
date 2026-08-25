import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  IOS_ONBOARDING_ANSWERS,
  IOS_USE_CASE_MAP,
  USER_USE_CASES,
  isWritableUseCase,
  iosAnswerToUseCase,
} from "@/lib/use-case-taxonomy";

// US-2535. Web writes users.use_case and personalises from it; iOS asked a
// different question and sent the answer only to telemetry, so an iOS user's
// column stayed NULL for ever.
//
// The blocker was a PRODUCT decision, now made: all three iOS answers map to
// `seller`, volume stays telemetry. This pins that decision as the spec the
// Swift side implements, so the phone writes a canonical value rather than
// re-deriving what a use case means.

const MIGRATION = "supabase/migrations/00022_user_onboarding.sql";
const SWIFT_STATE = "ios/GradeThread/Onboarding/OnboardingState.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("one taxonomy, matching the database (US-2535 AC2)", () => {
  it("the four values are exactly what the CHECK allows", () => {
    // A fifth value here would be written and then rejected by Postgres at
    // runtime, on the phone, after onboarding had already "succeeded".
    const sql = read(MIGRATION);
    expect(sql).toContain(
      "CHECK (use_case IN ('seller', 'buyer', 'consignment', 'developer'))",
    );
    expect([...USER_USE_CASES].sort()).toEqual([
      "buyer",
      "consignment",
      "developer",
      "seller",
    ]);
  });

  it("anything outside them is not writable", () => {
    for (const v of USER_USE_CASES) expect(isWritableUseCase(v)).toBe(true);
    for (const v of ["reseller", "grader", "store", "", null, 7, "Seller"]) {
      expect(isWritableUseCase(v), String(v)).toBe(false);
    }
  });
});

describe("the iOS mapping (US-2535 AC3)", () => {
  it("covers every answer iOS actually offers", () => {
    // Read from the Swift so the map cannot silently fall behind the enum. An
    // uncovered answer writes nothing and leaves the column NULL, which is the
    // bug this story is about.
    // Parse the OnboardingUseCase enum BODY, and compare the whole set. An
    // earlier version filtered the Swift cases down to the ones already known
    // here, which made the check vacuous in the only direction that matters:
    // a NEW iOS answer would have been filtered out and the test stayed green
    // while that answer wrote nothing and left the column NULL.
    const swift = read(SWIFT_STATE);
    const start = swift.indexOf("enum OnboardingUseCase");
    expect(start, "OnboardingUseCase enum not found").toBeGreaterThan(-1);
    const body = swift.slice(start, swift.indexOf("\n    var id:", start));
    const declared = [...body.matchAll(/^\s*case (\w+)\s*$/gm)].map((m) => m[1]!);
    expect(
      declared.sort(),
      "OnboardingUseCase in Swift no longer matches IOS_ONBOARDING_ANSWERS — " +
        "add the new answer to IOS_USE_CASE_MAP or it will write nothing",
    ).toEqual([...IOS_ONBOARDING_ANSWERS].sort());
    for (const answer of IOS_ONBOARDING_ANSWERS) {
      expect(IOS_USE_CASE_MAP[answer], `${answer} is unmapped`).toBeTruthy();
    }
  });

  it("all three resolve to seller, as decided", () => {
    expect(iosAnswerToUseCase("reseller")).toBe("seller");
    expect(iosAnswerToUseCase("grader")).toBe("seller");
    expect(iosAnswerToUseCase("store")).toBe("seller");
  });

  it("every mapped value is one the database will accept", () => {
    // The mapping cannot produce something the CHECK rejects.
    for (const v of Object.values(IOS_USE_CASE_MAP)) {
      expect(isWritableUseCase(v), v).toBe(true);
    }
  });

  it("an unknown answer resolves to null, not a guess", () => {
    // Better the default branch — which already lands on the seller
    // experience — than a wrong personalisation.
    for (const bad of ["", "  ", null, undefined, "SELLER", "consignor"]) {
      expect(iosAnswerToUseCase(bad), String(bad)).toBeNull();
    }
  });

  it("it is case- and whitespace-tolerant on the real answers", () => {
    expect(iosAnswerToUseCase(" Reseller ")).toBe("seller");
    expect(iosAnswerToUseCase("STORE")).toBe("seller");
  });
});

describe("the collapse is honest, and reversible (US-2535)", () => {
  it("the reasoning is written down, not just the mapping", () => {
    // A future reader seeing three-to-one will assume it was laziness unless
    // the alternative and why it was declined are on the page.
    const src = read("src/lib/use-case-taxonomy.ts");
    // The sentence wraps across comment lines, so compare against the comment
    // text with its line prefixes and newlines flattened out.
    const prose = src.replace(/\r?\n\s*\/\/ ?/g, " ");
    expect(prose).toContain('all three iOS answers are "sell"');
    expect(prose).toContain("Widening the CHECK to carry volume");
  });

  it("the web still personalises from the same column", () => {
    const dash = read("src/pages/dashboard.tsx");
    expect(dash).toContain("profile?.use_case");
    expect(dash).toContain("quickActionsFor");
  });

  it("a seller answer lands on the branch the default already used", () => {
    // Which is why AC4 needs no dashboard change: an iOS user goes from NULL
    // (default branch) to 'seller' (the same branch), explicitly rather than by
    // accident.
    const dash = read("src/pages/dashboard.tsx");
    expect(dash).toMatch(/case "seller":\s*\n\s*default:/);

    // US-2859 CHANGED WHAT THIS SECOND HALF CAN CLAIM, and the change is worth
    // stating rather than quietly rewriting. This used to assert the activation
    // checklist read the null-vs-seller difference, which it did — via
    // `const isReseller = useCase === "seller" || useCase === "consignment"`,
    // a gate that existed only to SEQUENCE this checklist behind the separate
    // FlipDesk one (US-1435). US-2859 merged those two lists, so the gate went
    // with the thing it was sequencing against, and the checklist now collapses
    // seller onto default exactly as the dashboard does.
    //
    // The taxonomy claim under test is unchanged and still asserted: an iOS
    // answer mapped to 'seller' reaches the same branch a null use_case already
    // reached, so the collapse is harmless here too.
    const steps = read("src/lib/activation-steps.ts");
    expect(steps).toMatch(/case "seller":\s*\n\s*default:/);
    expect(
      steps.includes('case "consignment":'),
      "consignment must still share the seller branch — the collapse is about " +
        "seller vs null, not about flattening every persona",
    ).toBe(true);
    expect(steps).toContain('case "developer":');
    expect(steps).toContain('case "buyer":');
  });
});

// AC3 landed 2026-08-16. The block this replaces asserted iOS did NOT write
// use_case and said to extend the guard when it did — and it read
// OnboardingState.swift, while the write went into a NEW file. So it would have
// stayed green with the feature shipped: an inverted guard pinned to a file the
// change did not touch. Worth naming, because "assert the absence, revisit
// later" reads like diligence and expires silently.
describe("iOS persists the answer (US-2535 AC3)", () => {
  const SWIFT_SYNC = "ios/GradeThread/Onboarding/UseCaseSync.swift";

  it("writes the users.use_case column", () => {
    const swift = read(SWIFT_SYNC);
    expect(swift).toMatch(/\.from\("users"\)/);
    expect(swift).toMatch(/update\(Update\(use_case: value\)\)/);
    expect(swift).toMatch(/\.eq\("id", value: userId\)/);
  });

  it("writes the CANONICAL value, never the iOS raw answer", () => {
    // The whole failure this guards: sending `reseller` would be rejected by
    // the 00022 CHECK after onboarding has already told the user it worked.
    const swift = read(SWIFT_SYNC);
    for (const answer of IOS_ONBOARDING_ANSWERS) {
      expect(
        new RegExp(`use_case:\\s*"${answer}"`).test(swift),
        `UseCaseSync writes the raw iOS answer "${answer}"; it must write ` +
          `"${IOS_USE_CASE_MAP[answer]}" — the value the DB CHECK allows.`,
      ).toBe(false);
    }
    // And the value it does write is the one this module maps to.
    const mapped = [...new Set(Object.values(IOS_USE_CASE_MAP))];
    expect(mapped).toHaveLength(1);
    expect(swift).toContain(`return "${mapped[0]}"`);
  });

  it("the Swift switch is exhaustive over the same three answers", () => {
    // A dictionary with a default would let a fourth iOS option write nothing
    // and leave the column NULL — this story's own bug. An exhaustive switch
    // makes it a compile error instead.
    const swift = read(SWIFT_SYNC);
    const caseLine = swift.match(/case ([^:]+): return "seller"/);
    expect(caseLine, "the canonical mapping switch was restructured").not.toBeNull();
    const answers = (caseLine?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^\./, ""))
      .sort();
    expect(answers).toEqual([...IOS_ONBOARDING_ANSWERS].sort());
    expect(swift).not.toMatch(/default:\s*return "seller"/);
  });

  it("is attempted on sign-in as well as at completion", () => {
    // Onboarding can finish BEFORE the user signs in — that is why
    // pendingFirstAction exists — and in that order there is no session to
    // write against. One call site is not enough.
    const content = read("ios/GradeThread/ContentView.swift");
    const calls = content.match(/UseCaseSync\.pushIfNeeded\(\)/g) ?? [];
    expect(
      calls.length,
      "expected the push at BOTH onboarding completion and the signedIn " +
        "transition; found " + calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("a failed write is retried, not marked done", () => {
    // Marking synced in the catch would lose the answer permanently on one
    // flaky request, which is a quieter version of the bug being fixed.
    const swift = read(SWIFT_SYNC);
    const catchBlock = swift.slice(swift.indexOf("} catch {"));
    expect(catchBlock).not.toContain("syncedKey");
  });
});
