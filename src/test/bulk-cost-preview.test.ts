import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateBulkCost } from "@/lib/bulk-cost-estimate";
import { GRADETHREAD_TIERS } from "@/lib/constants";

// US-2516. The bulk uploader looped every valid row straight into
// /api/grade/submit — no estimate, no confirmation, no way to stop it, and
// nothing distinguishing a row that got paid from a row the server created
// unpaid. The per-submission flow has shown a payment estimate since US-207.
//
// Two halves guarded here: the arithmetic (it must match the server's
// precedence, in row order) and the page wiring (nothing charges before a
// confirmation, the loop is cancellable, failures are retryable).

const PAGE = "src/pages/bulk-submission.tsx";

function page(): string {
  return readFileSync(resolve(process.cwd(), PAGE), "utf8");
}

describe("estimateBulkCost mirrors the server precedence (US-2516)", () => {
  it("an empty batch costs nothing", () => {
    const e = estimateBulkCost([], { includedRemaining: 3, creditBalance: 10 });
    expect(e).toMatchObject({ rows: 0, checkoutCents: 0, creditBalanceAfter: 10 });
  });

  it("draws the included bundle first, then credits, then checkout", () => {
    // 4 Standard rows, 2 included left, 1 credit on hand:
    //   rows 1-2 included, row 3 credits, row 4 checkout.
    const e = estimateBulkCost(
      ["standard", "standard", "standard", "standard"],
      { includedRemaining: 2, creditBalance: 1 },
    );
    expect(e.includedRows).toBe(2);
    expect(e.creditRows).toBe(1);
    expect(e.creditsSpent).toBe(1);
    expect(e.checkoutRows).toBe(1);
    expect(e.checkoutCents).toBe(GRADETHREAD_TIERS.standard.priceCents);
    expect(e.creditBalanceAfter).toBe(0);
  });

  it("never spends an included grade on Premium or Express", () => {
    // The included bundle is Standard-only (grade-billing.ts). A Premium row
    // must reach for credits even with the whole bundle untouched.
    const e = estimateBulkCost(["premium"], {
      includedRemaining: 50,
      creditBalance: 3,
    });
    expect(e.includedRows).toBe(0);
    expect(e.creditRows).toBe(1);
    expect(e.creditsSpent).toBe(GRADETHREAD_TIERS.premium.creditCost);
  });

  it("charges each tier's own price when the balance runs out", () => {
    const e = estimateBulkCost(["express", "premium"], {
      includedRemaining: 0,
      creditBalance: 0,
    });
    expect(e.checkoutRows).toBe(2);
    expect(e.checkoutCents).toBe(
      GRADETHREAD_TIERS.express.priceCents + GRADETHREAD_TIERS.premium.priceCents,
    );
  });

  it("respects row order — a cheap row later cannot jump the queue", () => {
    // 2 credits, an Express row (5 credits) then a Standard row (1). The
    // Express row cannot be afforded, but it must NOT hand its credits to the
    // Standard row that follows... the Standard row can still use them,
    // because the server charges each row as it reaches it.
    const e = estimateBulkCost(["express", "standard"], {
      includedRemaining: 0,
      creditBalance: 2,
    });
    expect(e.checkoutRows).toBe(1);
    expect(e.checkoutCents).toBe(GRADETHREAD_TIERS.express.priceCents);
    expect(e.creditRows).toBe(1);
    expect(e.creditBalanceAfter).toBe(1);
  });

  it("ignores a negative or fractional balance rather than crediting it", () => {
    const e = estimateBulkCost(["standard"], {
      includedRemaining: -5,
      creditBalance: 0.5,
    });
    expect(e.checkoutRows).toBe(1);
  });
});

describe("the bulk page cannot charge without a confirmation (US-2516)", () => {
  it("the submit button opens the confirmation, it does not run the batch", () => {
    const src = page();
    expect(src).toMatch(/onClick=\{\(\) => setConfirmOpen\(true\)\}/);
    // The only place the loop starts from the main button is inside the dialog.
    expect(src).toMatch(/setConfirmOpen\(false\);\s*\n\s*void runBatch\(validRows\)/);
  });

  it("the confirmation shows the cost breakdown", () => {
    const src = page();
    expect(src).toContain("<CostSummary");
    expect(src).toMatch(/estimateBulkCost\(/);
  });

  it("the loop is cancellable and checks the flag before charging a row", () => {
    const src = page();
    expect(src).toMatch(/const cancelRef = useRef\(false\)/);
    // The check must sit before the fetch, not after it.
    const body = src.slice(src.indexOf("async function runBatch"));
    const checkAt = body.indexOf("if (cancelRef.current)");
    const fetchAt = body.indexOf("/api/grade/submit");
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(fetchAt);
    expect(src).toContain("Stop batch");
  });

  it("counts rows the server created UNPAID apart from paid ones", () => {
    const src = page();
    // grade.ts returns 201 with payment.paid=false when checkout is required,
    // so counting every 201 as a success overstated what the batch achieved.
    expect(src).toMatch(/if \(json\.payment\?\.paid\)/);
    expect(src).toMatch(/awaitingPayment\+\+/);
  });

  it("failed rows are retryable without re-uploading the CSV and ZIP", () => {
    const src = page();
    expect(src).toMatch(/failedRows\.push\(row\)/);
    expect(src).toMatch(/runBatch\(result\.failedRows\)/);
  });
});
