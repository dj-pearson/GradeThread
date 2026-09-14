import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeNetProfit } from "@/lib/sale-math";

// US-3367: the dialog previews the number the edge writes. Same expression,
// pinned by source, so the preview and the stored net_profit cannot disagree.

describe("computeNetProfit", () => {
  it("is price plus shipping collected minus every cost and the cost basis", () => {
    expect(
      computeNetProfit(
        {
          sale_price: 40,
          shipping_collected: 5,
          platform_fees: 4,
          payment_processing_fees: 1.5,
          shipping_cost: 6,
          tax: 0,
          other_costs: 0.5,
        },
        10,
      ),
    ).toBeCloseTo(23);
  });

  it("is the same formula the edge uses (record-sale.ts)", () => {
    const web = readFileSync("src/lib/sale-math.ts", "utf8");
    const edge = readFileSync("services/edge-functions/src/lib/record-sale.ts", "utf8");
    const formula =
      /return i\.sale_price \+ i\.shipping_collected - i\.platform_fees -\s*i\.payment_processing_fees - i\.shipping_cost - i\.tax - i\.other_costs - purchasePrice;/;
    expect(web).toMatch(formula);
    expect(edge).toMatch(formula);
  });

  // The case above pinned two copies and the comment at the top of this file
  // said the third -- the dialog -- was one of them. It was not: until
  // 2026-09-13 record-sale-dialog.tsx spelled the whole expression out in its
  // own useMemo, so the preview a seller reads before pressing Save was the one
  // copy nothing checked, and check-web-unwired.mjs was correctly reporting
  // sale-math.ts as a module no production file imports. Assert the wiring, not
  // just the arithmetic: a formula guard cannot see a caller that never calls.
  it("is what the Record Sale dialog actually previews", () => {
    const dialog = readFileSync(
      "src/components/flipdesk/record-sale-dialog.tsx",
      "utf8",
    );
    expect(dialog).toMatch(/import \{ computeNetProfit \} from "@\/lib\/sale-math"/);
    expect(dialog).toMatch(/computeNetProfit\(/);
    // And it must not grow a fourth copy: no inline re-derivation of the sum.
    expect(dialog).not.toMatch(/n\(form\.sale_price\)\s*\+\s*\n?\s*n\(form\.shipping_collected\)\s*-/);
  });
});
