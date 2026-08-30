import { describe, it, expect } from "vitest";
import {
  packetWarnings,
  scheduleCRows,
  buildPacketCsv,
  PACKET_EXCLUSIONS,
  type PacketInput,
} from "./tax-packet";
import { buildStatement } from "./pnl-statement";
import { saleEntries } from "./ledger-math";

// US-2996.

const SALE = {
  sale_price: "180.00",
  shipping_collected: "12.99",
  platform_fees: "23.40",
  payment_processing_fees: "5.22",
  shipping_cost: "9.85",
  grading_cost: "3.00",
  other_costs: "1.15",
  tax: "14.87",
};

function input(over: Partial<PacketInput> = {}): PacketInput {
  return {
    taxYear: "2025",
    from: "2025-01-01",
    to: "2026-01-01",
    accountingMethod: "cash",
    entityType: "sole_prop",
    filingStatus: "single",
    hasEin: false,
    statement: buildStatement(
      saleEntries(SALE, "42.00", null, true).map((e) => ({
        account: e.account,
        amount_cents: e.amount_cents,
      })),
    ),
    cogs: {
      from: "2025-01-01",
      to: "2026-01-01",
      line_35_beginning_cents: 8500,
      line_35_present: true,
      line_35_reconstructed: false,
      line_36_purchases_cents: 0,
      line_41_ending_cents: 2500,
      line_41_present: true,
      line_41_reconstructed: false,
      line_42_cogs_cents: 6000,
      sold_cost_basis_cents: 6000,
      sold_item_count: 1,
      variance_cents: 0,
      items_without_cost: { beginning: 0, purchases: 0, ending: 0 },
      purchase_item_count: 1,
    },
    bridges: [],
    mileage: null,
    vehicleYear: null,
    homeOfficeCents: 0,
    homeOfficeSquareFeet: null,
    homeOfficeMonths: null,
    snapshotTotalCents: 2500,
    snapshotItemCount: 1,
    snapshotReconstructed: false,
    snapshotItemsWithoutCost: 0,
    reviewIssues: [],
    receiptCount: 0,
    expensesWithoutReceipt: 0,
    ...over,
  };
}

describe("packetWarnings", () => {
  it("says nothing when the books are clean", () => {
    expect(packetWarnings(input())).toEqual([]);
  });

  it("warns when inventory was never counted", () => {
    const w = packetWarnings(input({ cogs: null }));
    expect(w[0]?.headline).toMatch(/not counted at both ends/i);
    // The consequence, not just the fact: line 42 is arithmetic on a gap.
    expect(w[0]?.detail).toMatch(/should not be filed as-is/i);
  });

  it("warns that a rebuilt inventory figure is not a record of one", () => {
    expect(
      packetWarnings(input({ snapshotReconstructed: true }))[0]?.detail,
    ).toMatch(/not a record of one/i);
  });

  it("warns on a COGS variance, with the amount", () => {
    const w = packetWarnings(
      input({ cogs: { ...input().cogs!, variance_cents: -5000 } }),
    );
    expect(w[0]?.headline).toMatch(/\$50\.00/);
  });

  it("warns on a 1099-K variance, naming the platform", () => {
    const w = packetWarnings(
      input({
        bridges: [
          {
            platform: "ebay",
            tax_year: 2025,
            from: "2025-01-01",
            to: "2026-01-01",
            form_present: true,
            reported_gross_cents: 12324,
            payer_name: null,
            payer_tin_last4: null,
            reported_transaction_count: null,
            computed_gross_cents: 11824,
            sale_count: 1,
            variance_cents: 500,
            facilitator_tax_cents: 825,
            remitted_tax_cents: 0,
            shipping_income_cents: 999,
            fees_cents: -1590,
            shipping_cents: -750,
            cogs_cents: -3000,
            returns_cents: 0,
            profit_before_overheads_cents: 5659,
          },
        ],
      }),
    );
    expect(w[0]?.headline).toMatch(/ebay/);
    expect(w[0]?.headline).toMatch(/\$5\.00/);
  });

  it("does NOT warn on a platform with no form entered", () => {
    // A missing form is not a discrepancy. Warning about it would train the
    // seller to ignore the warnings that matter.
    const w = packetWarnings(
      input({
        bridges: [
          {
            platform: "ebay",
            form_present: false,
            variance_cents: 0,
          } as unknown as PacketInput["bridges"][number],
        ],
      }),
    );
    expect(w).toEqual([]);
  });

  it("carries every warning at once rather than only the first", () => {
    const w = packetWarnings(
      input({
        cogs: null,
        snapshotReconstructed: true,
        snapshotItemsWithoutCost: 3,
        expensesWithoutReceipt: 2,
      }),
    );
    expect(w.length).toBeGreaterThanOrEqual(4);
  });
});

describe("scheduleCRows", () => {
  it("is ordered by line number, the way the form is filled in", () => {
    const rows = scheduleCRows(input());
    const nums = rows.map((r) => parseInt(r.line, 10));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });

  it("prints costs as positive under their subtracted heading", () => {
    // The form asks for a positive number on line 10, not a negative one.
    const fees = scheduleCRows(input()).find((r) => r.line === "10");
    expect(fees?.cents).toBeGreaterThan(0);
  });

  it("keeps income positive", () => {
    const gross = scheduleCRows(input()).find(
      (r) => r.line === "1" && r.label === "Item sales",
    );
    expect(gross?.cents).toBe(18000);
  });

  it("omits zero DETAIL lines but keeps zero subtotals", () => {
    // A detail line with no activity is noise. A subtotal of zero is not: the
    // chain has to be followable, and omitting "returns and allowances: 0"
    // makes the next line appear to come from nowhere. Returns are zero in
    // this fixture and line 2 is present anyway.
    const rows = scheduleCRows(input());
    const zeros = rows.filter((r) => r.cents === 0);
    expect(zeros.map((r) => r.line)).toEqual(["2"]);
    // ...and no zero-valued expense or income detail row survived.
    expect(rows.filter((r) => r.cents === 0 && r.line !== "2")).toEqual([]);
  });

  it("carries the subtotals from the statement rather than recomputing", () => {
    // A packet that re-derived anything would be the fifth place a number could
    // disagree with itself, which is what US-2984 existed to stop.
    const rows = scheduleCRows(input());
    const net = rows.find((r) => r.line === "31");
    expect(net?.cents).toBe(input().statement.netProfitCents);
  });
});

describe("buildPacketCsv", () => {
  it("leads with the caveats when there are any", () => {
    const csv = buildPacketCsv(input({ cogs: null }));
    const caveatAt = csv.indexOf("READ THIS FIRST");
    const worksheetAt = csv.indexOf("SCHEDULE C WORKSHEET");
    expect(caveatAt).toBeGreaterThan(-1);
    // An accountant who reads the numbers first has already believed them.
    expect(caveatAt).toBeLessThan(worksheetAt);
  });

  it("omits the caveat block entirely when there is nothing to say", () => {
    expect(buildPacketCsv(input())).not.toContain("READ THIS FIRST");
  });

  it("names the accounting method and the period on the cover", () => {
    const csv = buildPacketCsv(input());
    expect(csv).toContain("Cash basis");
    expect(csv).toContain("2025-01-01 to 2026-01-01");
    expect(csv).toContain("end exclusive");
  });

  it("carries every section AC1 asks for", () => {
    const csv = buildPacketCsv(input());
    for (const heading of [
      "SCHEDULE C WORKSHEET",
      "PART III — COST OF GOODS SOLD",
      "1099-K RECONCILIATION",
      "MILEAGE",
      "HOME OFFICE",
      "INVENTORY AT THE END OF THE YEAR",
    ]) {
      expect(csv, heading).toContain(heading);
    }
  });

  it("says a section is absent rather than leaving it blank", () => {
    // A blank heading reads as a bug. "Not claimed for this year" reads as an
    // answer.
    const csv = buildPacketCsv(input({ cogs: null, mileage: null }));
    expect(csv).toContain("Not available — inventory was never counted");
    expect(csv).toContain("No trips logged for this year.");
    expect(csv).toContain("Not claimed for this year.");
  });

  it("lists unresolved review items so the accountant can ask", () => {
    const csv = buildPacketCsv(
      input({
        reviewIssues: [
          {
            kind: "no_cost_basis",
            subject_id: "x",
            title: "A jacket",
            happened_on: "2025-05-01",
            impact_cents: null,
            estimated_impact_cents: 8000,
            severity: 1,
            fix_kind: "item",
          },
        ],
      }),
    );
    expect(csv).toContain("STILL ON THE REVIEW LIST");
    // An estimate is labelled as one here too, not silently averaged in.
    expect(csv).toContain("about 80.00");
  });

  it("carries the not-tax-advice framing", () => {
    expect(buildPacketCsv(input())).toMatch(/does not give tax advice/i);
  });

  it("escapes a description that would otherwise break the CSV", () => {
    const csv = buildPacketCsv(
      input({
        reviewIssues: [
          {
            kind: "uncategorised",
            subject_id: "x",
            title: 'Uline, "big" order',
            happened_on: "2025-05-01",
            impact_cents: 5500,
            estimated_impact_cents: null,
            severity: 2,
            fix_kind: "expense",
          },
        ],
      }),
    );
    expect(csv).toContain('"Uline, ""big"" order"');
  });
});

describe("PACKET_EXCLUSIONS", () => {
  it("names what is NOT in here, so it is read rather than discovered", () => {
    const all = PACKET_EXCLUSIONS.join(" ").toLowerCase();
    expect(all).toContain("state");
    expect(all).toContain("self-employment");
    expect(all).toContain("depreciation");
    expect(all).toContain("8829");
  });

  it("says the honest one out loud", () => {
    // The limit that matters most and is easiest to leave unsaid.
    expect(PACKET_EXCLUSIONS.join(" ")).toMatch(/never recorded/i);
  });
});
