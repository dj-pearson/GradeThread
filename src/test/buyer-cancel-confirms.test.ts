import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2539. Cancelling a buyer plan was one unconfirmed click — no statement of
// what ends, no acknowledgement, no reason captured — while the seller side
// routed every cancellation through a two-step dialog that does all three. The
// plan tiles also truncated their feature lists at five, at the point of sale,
// with no way to see the rest.

const PAGE = "src/pages/buyer/billing.tsx";
const DIALOG = "src/components/billing/cancel-subscription-dialog.tsx";
const HOOKS = "src/hooks/use-billing-summary.ts";
const ROUTE = "services/edge-functions/src/routes/payments.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("a buyer cancellation confirms and explains (US-2539)", () => {
  it("the button opens the shared dialog instead of cancelling", () => {
    const src = read(PAGE);
    expect(src).toMatch(/onClick=\{\(\) => setCancelOpen\(true\)\}/);
    expect(src).toMatch(/<CancelSubscriptionDialog/);
    expect(src).toMatch(/product="buyer"/);
    // The one-click path is gone.
    expect(src).not.toMatch(/onClick=\{\(\) => cancel\.mutate\(\)\}/);
  });

  it("the dialog says what ends and what is kept, per product", () => {
    const src = read(DIALOG);
    expect(src).toMatch(/const isBuyer = product === "buyer"/);
    // Buyer consequences are the buyer's, not a copy of the seller's.
    expect(src).toContain("Condition alerts stop");
    expect(src).toContain("Cover on purchases already made");
    // And the seller's still say the seller's.
    expect(src).toContain("Caps drop to the Free tier");
  });

  it("pause and downgrade are not offered to a buyer", () => {
    // They are seller-plan features; offering them would be a dead end.
    expect(read(DIALOG)).toMatch(/\{!isBuyer && \(/);
  });

  it("the reason reaches the server", () => {
    const hooks = read(HOOKS);
    expect(hooks).toMatch(/useMutation<\{ ok: true \}, Error, \{ reason\?: string \} \| void>/);
    expect(hooks).toMatch(/json: \{ reason:/);
    const route = read(ROUTE);
    const buyerCancel = route.slice(
      route.indexOf('paymentRoutes.post("/buyer/cancel"'),
      route.indexOf('paymentRoutes.post("/buyer/uncancel"'),
    );
    expect(buyerCancel).toMatch(/metadata: \{ cancellation_reason: reason \}/);
  });

  it("the buyer reason does NOT overwrite the seller's column", () => {
    // users.cancellation_reason belongs to the seller subscription. One column
    // for two products is how churn reporting starts lying.
    const route = read(ROUTE);
    const buyerCancel = route.slice(
      route.indexOf('paymentRoutes.post("/buyer/cancel"'),
      route.indexOf('paymentRoutes.post("/buyer/uncancel"'),
    );
    expect(buyerCancel).not.toMatch(/update\(\{ cancellation_reason/);
  });

  it("a cancel with no body still works", () => {
    // The reason is optional and must never block a cancellation.
    const route = read(ROUTE);
    const buyerCancel = route.slice(
      route.indexOf('paymentRoutes.post("/buyer/cancel"'),
      route.indexOf('paymentRoutes.post("/buyer/uncancel"'),
    );
    expect(buyerCancel).toMatch(/\} catch \{/);
    expect(buyerCancel).toMatch(/No body is the historical caller/);
  });
});

describe("the plan tiles sell honestly (US-2539)", () => {
  it("every feature is listed, not the first five", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/features\.slice\(0, 5\)/);
    expect(src).toMatch(/plan\.features\.map\(/);
  });

  it("the yearly toggle states the saving, computed from the plans", () => {
    const src = read(PAGE);
    expect(src).toMatch(/function annualSavingPercent\(\)/);
    expect(src).toMatch(/save \{annualSavingPct\}%/);
    // Derived, never typed in: a hardcoded percentage is wrong the first time
    // a price moves.
    expect(src).toMatch(/plan\.priceMonthlyCents \* 12/);
  });

  it("it says nothing when there is nothing to save", () => {
    const src = read(PAGE);
    expect(src).toMatch(/if \(yearAtMonthly <= plan\.priceYearlyCents\) return 0/);
    expect(src).toMatch(/annualSavingPct > 0 &&/);
  });
});
