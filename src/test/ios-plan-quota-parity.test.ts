import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FLIPDESK_PLANS } from "@/lib/constants";

// US-2123. iOS carried its own copy of the per-plan AI-action allowance and it
// had drifted: pro said 1000 where the server grants 750, business said 5000
// where the server grants 2000.
//
// MEASURED AGAINST PRODUCTION on 2026-08-22, not inferred from the repo. The
// live `pricing_plans` rows read through PostgREST with the public anon key are
// free 25 / starter 200 / pro 750 / business 2000, and src/lib/constants.ts
// agrees with them. Only iOS disagreed.
//
// THE SYMPTOM WAS SILENT, which is why it lasted. A Pro seller opened
// Settings -> AI Assistant, read a 1000-action monthly cap, and hit the server's
// wall 250 actions early with nothing on screen explaining the gap. Nothing
// errored; the number was simply a lie told confidently.
//
// WHAT LET IT SURVIVE REVIEW is worth more than the fix: the Swift function's
// own doc comment said it "mirrors FLIPDESK_PLANS aiActionsPerMonth in
// src/lib/constants.ts: free 25 / starter 200 / pro 1000 / business 5000". The
// comment asserted the mirror AND restated the wrong numbers, so anyone
// checking the claim against the code found them agreeing with each other. A
// mirror is only a mirror if something compares the two sides.
//
// IN THE WEB SUITE, deliberately. Swift cannot be compiled on the Windows box
// this work happens on, and a guard that only runs on the macOS lane is one
// nobody sees until CI. Same reasoning as ios-accessibility-ratchet.test.ts.

const SWIFT = "ios/GradeThread/Settings/AIAssistantSection.swift";

/** The `planDefault` switch body, comments stripped. */
function planDefaultBody(): string {
  const src = readFileSync(resolve(process.cwd(), SWIFT), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    // Swift doc comments are `///`, ordinary ones `//`. Both must go: this
    // function's doc comment quotes the very numbers being asserted, so a scan
    // that kept it would pass against the wrong values.
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const start = code.indexOf("static func planDefault(");
  expect(start, `${SWIFT} no longer defines planDefault`).toBeGreaterThan(-1);
  return code.slice(start, code.indexOf("\n    }", start));
}

/** What the Swift switch returns for a plan key, read out of the source. */
function swiftValueFor(body: string, plan: string): number {
  const m = new RegExp(`case "${plan}"[^:]*:\\s*return\\s+(\\d+)`).exec(body);
  expect(m, `planDefault has no case for "${plan}"`).toBeTruthy();
  return Number(m![1]);
}

describe("iOS mirrors the server's AI-action allowance (US-2123)", () => {
  const body = planDefaultBody();

  it.each([
    ["starter", "starter"],
    ["pro", "pro"],
    ["business", "business"],
  ])("%s matches FLIPDESK_PLANS", (_label, key) => {
    const plan = FLIPDESK_PLANS[key as keyof typeof FLIPDESK_PLANS];
    expect(plan, `FLIPDESK_PLANS has no "${key}"`).toBeTruthy();
    expect(
      swiftValueFor(body, key),
      `${SWIFT} promises a different monthly AI-action cap for ${key} than the ` +
        `server enforces. A seller reads this number in Settings and then hits ` +
        `the wall somewhere else.`,
    ).toBe(plan.aiActionsPerMonth);
  });

  it("the default arm is the free allowance, not a guess", () => {
    // An unknown plan string must degrade to the smallest real allowance.
    // Anything larger would show a paid cap to an account that has not paid.
    const free = FLIPDESK_PLANS.free;
    const m = /default:\s*return\s+(\d+)/.exec(body);
    expect(m, "planDefault has no default arm").toBeTruthy();
    expect(Number(m![1])).toBe(free.aiActionsPerMonth);
  });

  it("every deniable plan key is covered, so none falls through to free", () => {
    // A plan missing from the switch would silently show its holder the FREE
    // cap — the same class of lie in the other direction.
    for (const key of Object.keys(FLIPDESK_PLANS)) {
      if (key === "free") continue;
      expect(
        new RegExp(`case "${key}"`).test(body),
        `planDefault has no case for the "${key}" plan, so its holders are ` +
          `shown the free allowance`,
      ).toBe(true);
    }
  });
});
