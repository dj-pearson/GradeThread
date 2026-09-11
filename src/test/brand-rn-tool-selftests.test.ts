import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// US-3128 -- run the brand-KB operator scripts' own self-tests in CI.
//
// Three scripts carry a `--self-test` and NOTHING RAN ANY OF THEM. That is the
// shape this repo keeps getting caught by: a guard whose output nobody reads is
// not a guard. Each of these parses something brittle that somebody else owns --
// the FTC's results markup, and the packs' dollar-quoted SQL -- and each fails in
// the expensive direction:
//
//   ftc-rn-lookup.mjs    a markup change that yields no rows reports "this brand
//                        has no RN" for EVERY brand, which is indistinguishable
//                        from the truth. Its fixture proves the parser still
//                        THROWS on a page it does not recognise.
//   ftc-rn-recheck.mjs   a scan that stops finding the registered_numbers column
//                        reports an empty audit, which reads as a clean one.
//   brand-kb-gap.mjs     a statement scanner that truncates on an embedded quote
//                        under-counts the KB, and every seller brand then looks
//                        missing. It has done exactly that before.
//
// All three are offline: fixtures and supabase/migrations, no network. The
// network paths of the two FTC scripts are deliberately NOT exercised here -- CI
// must not depend on a government website being up, and a red lane that means
// "the FTC is slow today" is a lane people stop reading.

const ROOT = resolve(process.cwd());

const SELF_TESTS = [
  ["scripts/ops/ftc-rn-lookup.mjs", /3 fixtures OK/],
  ["scripts/ops/ftc-rn-recheck.mjs", /self-test OK/],
  ["scripts/brand-kb-gap.mjs", /self-test OK/],
] as const;

describe("the brand-KB operator scripts pass their own self-tests", () => {
  for (const [script, expected] of SELF_TESTS) {
    it(`${script} --self-test`, () => {
      const out = execFileSync(process.execPath, [resolve(ROOT, script), "--self-test"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(out).toMatch(expected);
    });
  }
});
