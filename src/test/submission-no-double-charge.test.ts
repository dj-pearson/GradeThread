import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2538. When /api/grade/submit returns checkoutRequired, the submission row
// ALREADY EXISTS — it sits unpaid, waiting for a card. "Change tier" cleared the
// checkout state and put Submit back in front of the seller, so pressing it
// again POSTed /submit a second time and created a SECOND submission for the
// same garment. Two rows, two charges, one garment.

const PAGE = "src/pages/new-submission.tsx";

function src(): string {
  return readFileSync(resolve(process.cwd(), PAGE), "utf8");
}

describe("changing tier reuses the submission (US-2538)", () => {
  it("Change tier keeps the id rather than dropping it", () => {
    const text = src();
    expect(text).toMatch(/const \[repricingSubmissionId, setRepricingSubmissionId\]/);
    expect(text).toMatch(
      /setRepricingSubmissionId\(checkoutState\.submissionId\)/,
    );
  });

  it("submitting again re-prices instead of creating a second row", () => {
    const text = src();
    // The branch is the FIRST thing handleSubmit does, before any of the
    // upload work — anything after would still build a second multipart body.
    //
    // US-2789: the DECISION moved to lib/submit-action.ts so its ordering can
    // be tested by calling it (src/lib/__tests__/submit-action.test.ts). What
    // stays here is the property that test cannot see: where the decision sits
    // relative to the multipart build. A correct decision consulted too late
    // still assembles a second body.
    const submitAt = text.indexOf("async function handleSubmit()");
    const decideAt = text.indexOf("decideSubmitAction({", submitAt);
    const repriceAt = text.indexOf('action === "reprice"', submitAt);
    const formDataAt = text.indexOf("new FormData()", submitAt);
    expect(decideAt, "handleSubmit no longer asks decideSubmitAction").toBeGreaterThan(submitAt);
    expect(repriceAt, "handleSubmit no longer acts on the reprice answer").toBeGreaterThan(decideAt);
    expect(
      repriceAt,
      "the reprice branch moved after the multipart build, so a re-price still " +
        "assembles a second submission body",
    ).toBeLessThan(formDataAt);
  });

  it("the reprice uses the pay endpoint, not a second submit", () => {
    const text = src();
    expect(text).toMatch(/\/api\/grade\/pay\/\$\{submissionId\}/);
    // And it sends the NEW tier, or the change would be a no-op.
    expect(text).toMatch(/json: \{ tier \}/);
  });

  it("it handles all three outcomes the payment precedence can return", () => {
    const text = src();
    const fn = text.slice(
      text.indexOf("async function repriceExistingSubmission"),
      text.indexOf("async function handleSubmit()"),
    );
    expect(fn).toMatch(/payment\?\.paid/);
    expect(fn).toMatch(/payment\?\.checkoutRequired/);
    // The fallback still lands the seller on the row that exists rather than
    // stranding them on a form with nothing left to do.
    expect(fn).toMatch(/navigate\(`\/dashboard\/submissions\/\$\{submissionId\}`\)/);
  });

  it("a fresh checkout prompt clears any earlier reprice id", () => {
    // Otherwise a second garment in the same session would re-price the first
    // garment's row.
    const text = src();
    const branch = text.slice(text.indexOf("if (payment.checkoutRequired) {"));
    expect(branch.slice(0, 200)).toMatch(/setRepricingSubmissionId\(null\)/);
  });

  it("the double-submit lock still guards the reprice path", () => {
    const text = src();
    const fn = text.slice(
      text.indexOf("async function repriceExistingSubmission"),
      text.indexOf("async function handleSubmit()"),
    );
    expect(fn).toMatch(/if \(submitLockRef\.current\) return/);
    expect(fn).toMatch(/submitLockRef\.current = false/);
  });
});

describe("the tier is chosen in one place (US-2538)", () => {
  it("both steps render the same control", () => {
    const text = src();
    const uses = text.match(/<GradePricingSummary/g) ?? [];
    expect(uses.length).toBe(2);
    // The bare three-button grid that duplicated it is gone.
    expect(text).not.toMatch(/onClick=\{\(\) => setTier\(key\)\}/);
  });

  it("the surviving control carries what the grid did not", () => {
    // Credit balance, included count and plan name — the review step used to
    // ask for a tier while showing none of them.
    const text = src();
    const review = text.slice(text.indexOf("Grade tier + pricing (US-207)"));
    expect(review).toMatch(/creditBalance=\{creditBalance\}/);
    expect(review).toMatch(/includedUsed=\{includedUsed\}/);
    expect(review).toMatch(/planName=\{planLabel\(usage\.plan\)\}/);
  });
});
