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
//   brand-field-audit.mjs  (US-3307) reports how much of inventory_items.brand is
//                        not a maker. Its failure mode is a QUIET one: a
//                        classification that stops matching reports a clean
//                        field, which is the answer everybody wants to hear. The
//                        self-test scores the captured prod fixture and asserts
//                        it still finds the licensor and the fibre.
//   brand-colorway-gap.mjs (US-3127) same scanner, same failure mode, applied to
//                        the colorway side: a statement it stops parsing reads as
//                        a brand with no palette, which is precisely the finding
//                        the script exists to make. Its self-test asserts the
//                        real corpus still yields 10,000+ rows with zero unparsed
//                        statements and zero orphan brand keys.
//   brand-feed-probe.mjs   (US-3125) pins the four-outcome classifier. Collapsing
//                        `refused` into `none` writes off brands that are merely
//                        rate-limiting, and nobody looks again. It also pins that
//                        a 200 carrying HTML is NOT a feed, which is the one that
//                        would otherwise seed a bot-challenge page's contents.
//   shopify-brand-harvest.mjs  same bot-challenge guard on the read side.
//
// All of them are offline: fixtures and supabase/migrations, no network. The
// network paths of the two FTC scripts and the two harvest scripts are
// deliberately NOT exercised here -- CI must not depend on a government website
// or a brand's storefront being up, and a red lane that means "the FTC is slow
// today" is a lane people stop reading.

const ROOT = resolve(process.cwd());

const SELF_TESTS = [
  ["scripts/ops/ftc-rn-lookup.mjs", /3 fixtures OK/],
  ["scripts/ops/ftc-rn-recheck.mjs", /self-test OK/],
  ["scripts/brand-kb-gap.mjs", /self-test OK/],
  ["scripts/brand-field-audit.mjs", /self-test OK/],
  ["scripts/brand-colorway-gap.mjs", /self-test OK/],
  ["scripts/ops/brand-feed-probe.mjs", /self-test: \d+ cases OK/],
  ["scripts/ops/shopify-brand-harvest.mjs", /self-test: .*OK/],
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
