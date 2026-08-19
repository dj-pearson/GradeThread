import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MIN_RETURN_SAMPLE,
  gradedReturnAdvantage,
  lowVsHighBandMultiplier,
  type ReturnReductionSummary,
} from "@/lib/flipdesk-returns-analytics";

// US-2533. Return-reduction analytics is web-only, and AC2 asks the iOS section
// to be "driven by the same server rollup the web tab uses".
//
// Reading both sides shows the rollup is reachable already: flipdesk_return_reduction
// is SECURITY INVOKER with execute granted to `authenticated`, so an iOS client
// on the same Supabase project can call it with no new endpoint.
//
// What is NOT on the server is the part that matters most. The RPC returns raw
// COUNTS; the rules that decide whether a claim may be made at all live in
// TypeScript. Those rules are editorial, not cosmetic:
//
//   • a minimum sample before any multiplier is shown, and
//   • never present a WORSE number as an ROI win.
//
// A Swift reimplementation that got either wrong would tell a paying seller
// "graded items return 3x less" off two sales, or spin a worse result as a
// victory — a claim about our own product's value, made to the person buying it.
// So the rules are pinned here as the spec that implementation must satisfy.

const LIB = "src/lib/flipdesk-returns-analytics.ts";
const MIGRATION = "supabase/migrations/00168_flipdesk_return_reduction.sql";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

function summary(
  graded: [sold: number, returns: number],
  ungraded: [sold: number, returns: number],
): ReturnReductionSummary {
  const stat = ([sold, returns]: [number, number]) => ({
    sold,
    returns,
    returnRate: sold > 0 ? returns / sold : null,
  });
  return {
    overall: stat([graded[0] + ungraded[0], graded[1] + ungraded[1]]),
    graded: stat(graded),
    ungraded: stat(ungraded),
    bands: [],
  };
}

describe("no claim below the sample floor (US-2533)", () => {
  it("the floor is ten, on both sides", () => {
    expect(MIN_RETURN_SAMPLE).toBe(10);
  });

  it("a tiny sample yields NO multiplier, however flattering", () => {
    // 2 sales, 0 returns vs 2 sales, 2 returns looks like an infinite win.
    expect(gradedReturnAdvantage(summary([2, 0], [2, 2]))).toBeNull();
    expect(gradedReturnAdvantage(summary([9, 1], [50, 25]))).toBeNull();
    expect(gradedReturnAdvantage(summary([50, 5], [9, 5]))).toBeNull();
  });

  it("exactly at the floor is enough", () => {
    // The boundary is worth pinning: an off-by-one here silently suppresses a
    // legitimate claim, or admits an illegitimate one.
    expect(gradedReturnAdvantage(summary([10, 1], [10, 5]))).toBeCloseTo(5);
  });
});

describe("a worse number is never spun as a win (US-2533)", () => {
  it("graded returning MORE yields null, not a multiplier below one", () => {
    // Returning 0.5 here would render as "graded items return 0.5x less",
    // which reads as a win and is the opposite of the truth.
    expect(gradedReturnAdvantage(summary([100, 20], [100, 10]))).toBeNull();
  });

  it("a tie yields null", () => {
    expect(gradedReturnAdvantage(summary([100, 10], [100, 10]))).toBeNull();
  });

  it("a zero graded return rate yields null rather than infinity", () => {
    // Dividing by zero would produce Infinity and render as "Infinityx less".
    expect(gradedReturnAdvantage(summary([100, 0], [100, 10]))).toBeNull();
  });

  it("the band comparison follows the same three rules", () => {
    const withBands = (
      low: [number, number],
      high: [number, number],
    ): ReturnReductionSummary => ({
      ...summary([0, 0], [0, 0]),
      bands: [
        { key: "low", label: "Low", sold: low[0], returns: low[1], returnRate: low[0] ? low[1] / low[0] : null },
        { key: "high", label: "High", sold: high[0], returns: high[1], returnRate: high[0] ? high[1] / high[0] : null },
      ],
    });
    // Below the floor.
    expect(lowVsHighBandMultiplier(withBands([5, 3], [50, 5]))).toBeNull();
    // High band returning MORE than low — not a win.
    expect(lowVsHighBandMultiplier(withBands([100, 5], [100, 20]))).toBeNull();
    // Zero denominator.
    expect(lowVsHighBandMultiplier(withBands([100, 20], [100, 0]))).toBeNull();
    // A real advantage.
    expect(
      lowVsHighBandMultiplier(withBands([100, 20], [100, 5]))?.multiplier,
    ).toBeCloseTo(4);
  });

  it("a missing band yields null rather than a partial comparison", () => {
    expect(lowVsHighBandMultiplier(summary([100, 5], [100, 20]))).toBeNull();
  });
});

describe("the rollup is reachable by a second client (US-2533 AC2)", () => {
  it("the RPC is granted to authenticated, so iOS needs no new endpoint", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain(
      "grant execute on function public.flipdesk_return_reduction(date) to authenticated;",
    );
  });

  it("it is SECURITY INVOKER, so RLS still scopes it to the caller", () => {
    // A DEFINER rollup called from a phone would be a cross-tenant read.
    const code = read(MIGRATION)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(code).toMatch(/security invoker/i);
    expect(code).not.toMatch(/security\s+definer/i);
  });

  it("the web calls that RPC rather than assembling its own query", () => {
    expect(read(LIB)).toContain('client.rpc("flipdesk_return_reduction"');
  });
});

describe("the iOS port satisfies these rules rather than restating them (US-2533 AC2)", () => {
  // This block used to assert that NO iOS return-analytics path existed, and
  // its failure message told the next author to extend it rather than delete
  // it when one appeared. One has.
  //
  // The rules are ported, not called - Swift cannot import TypeScript - so what
  // this can hold is that the two agree on every number and every refusal. The
  // FLOOR is the one most likely to drift, so it is read out of the Swift
  // source and compared against the constant above rather than trusted.

  const STORE = "ios/GradeThread/Analytics/ReturnReductionStore.swift";
  const VIEW = "ios/GradeThread/Analytics/AnalyticsView.swift";

  const swift = () =>
    read(STORE)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("the Swift floor IS this floor", () => {
    const declared = /static let minReturnSample = (\d+)/.exec(swift())?.[1];
    expect(declared, "minReturnSample vanished from the Swift").toBeTruthy();
    expect(Number(declared)).toBe(MIN_RETURN_SAMPLE);
  });

  it("both sides must clear it before any claim", () => {
    const src = swift();
    expect(src).toContain("graded.sold >= minReturnSample");
    expect(src).toContain("ungraded.sold >= minReturnSample");
    expect(src).toContain("low.sold >= minReturnSample");
    expect(src).toContain("high.sold >= minReturnSample");
  });

  it("a worse or equal number is refused, in BOTH comparisons", () => {
    // The strict > is the rule. Flipping either to >= would render a tie, and
    // flipping the direction would render a loss, as a win.
    const src = swift();
    expect(src).toContain("gradedRate > 0, ungradedRate > gradedRate");
    expect(src).toContain("highRate > 0, lowRate > highRate");
  });

  it("the section renders through the rules, never off raw counts", () => {
    // The rules existing in a file nothing calls would be the shipped-but-
    // unwired shape, so the CARD is checked for its call into the body and the
    // body for its call into the rules. Checking only the second left this
    // green when the card stopped rendering the body at all - the whole chain
    // has to be pinned, not its far end.
    const view = read(VIEW);
    const cardStart = view.indexOf("private var returnsCard: some View {");
    expect(cardStart, "the returns card vanished").toBeGreaterThan(-1);
    const card = view.slice(cardStart, view.indexOf("@ViewBuilder", cardStart));
    expect(card).toContain("returnsBody(summary)");
    // And that the card is actually ON the screen. Deleting one line from the
    // content stack leaves the card, the body and the rules all present and
    // renders none of them - a section that exists in the file and nowhere in
    // the app, which is the failure this repo keeps re-finding.
    const contentStart = view.indexOf("private var content: some View {");
    expect(contentStart, "the analytics content stack vanished").toBeGreaterThan(-1);
    const stack = view.slice(contentStart, view.indexOf(".padding(16)", contentStart));
    expect(stack).toContain("returnsCard");
    expect(view).toContain("ReturnClaimRules.lowVsHigh(summary)");
    expect(view).toContain("ReturnClaimRules.gradedAdvantage(summary)");
    expect(view).not.toMatch(/summary\.ungraded\.returnRate\s*\/\s*summary\.graded\.returnRate/);
  });

  it("it reads the shared RPC, not a phone-side reimplementation", () => {
    // Not whitespace-anchored: a formatter run should not redden a guard about
    // which function is called.
    const src = swift();
    expect(src).toContain('"flipdesk_return_reduction"');
    expect(src).toContain(".rpc(");
    // The counts come from the server. A phone that summed its own local sales
    // mirror would answer a different question - the phone knows what it has
    // synced, not what the ledger holds.
    expect(src).not.toMatch(/LocalInventoryItem|modelContext/);
  });

  it("the range picker drives it (AC3)", () => {
    // Without this the section shows a 90-day number under a 30-day heading.
    const view = read(VIEW);
    expect(view).toContain("task(id: range) { await returns.refresh(periodStart: range.start(now: .now)) }");
  });

  it("low-sample bands are shown and marked, not hidden", () => {
    // Dropping a band would satisfy "no unreliable claim" by leaving the seller
    // wondering where a grade band went.
    expect(swift()).toContain("band.sold > 0 && band.sold < minReturnSample");
    expect(read(VIEW)).toContain("ForEach(summary.bands)");
  });

  it("still tracks the story", () => {
    const tracker = read("docs/reviews/full-surface-2026-08/FIX-PROGRESS.md");
    expect(tracker).toContain("US-2533");
  });
});
