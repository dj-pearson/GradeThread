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
    // accident — and the activation checklist DOES read the difference.
    const dash = read("src/pages/dashboard.tsx");
    expect(dash).toMatch(/case "seller":\s*\n\s*default:/);
    const checklist = read("src/components/onboarding/activation-checklist.tsx");
    expect(checklist).toContain('useCase === "seller"');
  });
});

describe("what this slice does NOT claim (US-2535)", () => {
  it("iOS is not asserted to persist the answer yet", () => {
    // AC3's write is Swift. When it lands it imports nothing from here — it
    // writes the canonical string this map produces, which is why the guard
    // reads the Swift enum rather than trusting a copy of it.
    const swift = read(SWIFT_STATE);
    expect(
      /use_case/.test(swift),
      "iOS now writes use_case — extend this guard to assert it writes the " +
        "value IOS_USE_CASE_MAP produces",
    ).toBe(false);
  });
});
