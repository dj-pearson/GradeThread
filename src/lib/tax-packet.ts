import { formatCents } from "@/lib/ledger-math";
import { escapeCsvCell } from "@/lib/items-csv";
import type { PnlStatement } from "@/lib/pnl-statement";
import { statementTotals } from "@/lib/pnl-statement";
import type { CogsWorksheet } from "@/lib/cogs";
import type { Bridge1099k } from "@/lib/form-1099k";
import type { MileageSummary, VehicleUseYear } from "@/lib/mileage";
import type { ReviewIssue } from "@/lib/books-review";

// US-2996 — the year-end tax packet.
//
// This is the payoff for the whole epic. A reseller's actual March task is
// assembling numbers from four places and emailing them to somebody who bills
// by the hour for every follow-up question. One complete, self-explaining
// download is worth more than every chart on the finances page.
//
// EVERYTHING HERE IS PURE. It takes the figures the other stories already
// compute and turns them into files. It fetches nothing and computes no totals
// of its own -- a packet that re-derived anything would be the fifth place a
// number could disagree with itself, which is what US-2984 existed to stop.

export interface PacketInput {
  taxYear: string;
  from: string;
  /** Exclusive. */
  to: string;
  accountingMethod: string;
  entityType: string;
  filingStatus: string;
  hasEin: boolean;
  statement: PnlStatement;
  cogs: CogsWorksheet | null;
  bridges: Bridge1099k[];
  mileage: MileageSummary | null;
  vehicleYear: VehicleUseYear | null;
  homeOfficeCents: number;
  homeOfficeSquareFeet: number | null;
  homeOfficeMonths: number | null;
  snapshotTotalCents: number | null;
  snapshotItemCount: number | null;
  snapshotReconstructed: boolean;
  snapshotItemsWithoutCost: number;
  reviewIssues: ReviewIssue[];
  receiptCount: number;
  expensesWithoutReceipt: number;
}

export interface PacketWarning {
  /** Short enough to print on the cover. */
  headline: string;
  detail: string;
}

/**
 * What is wrong with this packet, before it is built (AC5, AC6).
 *
 * Returned rather than thrown. A partial packet delivered beats a perfect one
 * blocked: the seller's accountant is waiting, and a list of caveats on the
 * cover is exactly what they need to know which numbers to ask about.
 */
export function packetWarnings(input: PacketInput): PacketWarning[] {
  const out: PacketWarning[] = [];

  if (!input.cogs || !input.cogs.line_35_present || !input.cogs.line_41_present) {
    out.push({
      headline: "Inventory was not counted at both ends of the year",
      detail:
        "Schedule C Part III lines 35 and 41 need an opening and closing inventory figure. Without both, line 42 (cost of goods sold) is arithmetic on a gap and should not be filed as-is.",
    });
  }

  if (input.snapshotReconstructed) {
    out.push({
      headline: "The inventory figure was rebuilt after the fact",
      detail:
        "It was reconstructed from surviving records rather than counted on the day. It is the best available answer, not a record of one.",
    });
  }

  if (input.snapshotItemsWithoutCost > 0) {
    out.push({
      headline: `${input.snapshotItemsWithoutCost} item(s) in inventory have no purchase price`,
      detail:
        "They are valued at zero, which makes closing inventory too small and cost of goods sold too large. The true figures are unknown.",
    });
  }

  if (input.cogs && input.cogs.variance_cents !== 0) {
    out.push({
      headline: `Two routes to cost of goods sold differ by ${formatCents(Math.abs(input.cogs.variance_cents))}`,
      detail:
        "Adding up inventory gives one figure and adding up what the sold items cost gives another. The usual cause is a purchase date in the wrong year.",
    });
  }

  for (const b of input.bridges) {
    if (b.form_present && b.variance_cents !== 0) {
      out.push({
        headline: `The ${b.platform} 1099-K differs from our records by ${formatCents(Math.abs(b.variance_cents))}`,
        detail:
          "Either sales are missing from these books, or the platform counted something we did not. The reconciliation page in this packet lists the likely causes.",
      });
    }
  }

  if (input.mileage && input.mileage.trips_without_a_rate > 0) {
    out.push({
      headline: `${input.mileage.trips_without_a_rate} mileage trip(s) are worth nothing here`,
      detail:
        "No published rate covers their dates, so they add nothing to the deduction. Their miles are still listed in the log.",
    });
  }

  if (input.mileage && input.mileage.trips_on_a_provisional_rate > 0) {
    out.push({
      headline: "Some mileage uses a rate we carried forward",
      detail:
        "The IRS had not published a rate for those dates when this was generated. Confirm the published figure before filing.",
    });
  }

  if (input.reviewIssues.length > 0) {
    out.push({
      headline: `${input.reviewIssues.length} item(s) were still on the review list`,
      detail:
        "These are things the books flagged and nobody resolved. They are listed in full at the end of this packet.",
    });
  }

  if (input.expensesWithoutReceipt > 0) {
    out.push({
      headline: `${input.expensesWithoutReceipt} expense(s) over $75 have no receipt`,
      detail:
        "The deductions are not necessarily wrong, but they are the ones that could not be evidenced if anyone asked.",
    });
  }

  return out;
}

const METHOD_LABELS: Record<string, string> = {
  cash: "Cash basis",
  accrual: "Accrual basis",
};

const ENTITY_LABELS: Record<string, string> = {
  sole_prop: "Sole proprietor",
  single_member_llc: "Single-member LLC",
  multi_member_llc: "Multi-member LLC",
  partnership: "Partnership",
  s_corp: "S corporation",
  c_corp: "C corporation",
};

/** The Schedule C worksheet, as line-number rows. */
export interface WorksheetRow {
  line: string;
  label: string;
  cents: number;
  /** Set where the figure is not to be trusted as printed. */
  caveat?: string;
}

export function scheduleCRows(input: PacketInput): WorksheetRow[] {
  const s = input.statement;
  const rows: WorksheetRow[] = [];

  for (const section of s.sections) {
    for (const line of section.lines) {
      if (!line.scheduleCLine) continue;
      if (line.cents === 0) continue;
      rows.push({
        line: line.scheduleCLine,
        label: line.label,
        // Printed as the form reads: a cost is a positive number under a
        // subtracted heading.
        cents: section.key === "income" ? line.cents : Math.abs(line.cents),
      });
    }
  }

  // Subtotals, in form order, from the statement rather than recomputed.
  for (const t of statementTotals(s)) {
    const line = /line (\d+[a-z]?)/i.exec(t.hint ?? "")?.[1];
    if (!line) continue;
    rows.push({
      line,
      label: t.label,
      cents: t.key === "operating_expenses" ? Math.abs(t.cents) : t.cents,
    });
  }

  rows.sort((a, b) => {
    const na = parseInt(a.line, 10);
    const nb = parseInt(b.line, 10);
    if (na !== nb) return na - nb;
    return a.line.localeCompare(b.line);
  });
  return rows;
}

/**
 * The whole packet as CSV text (AC2).
 *
 * One file with sections rather than several, because an accountant opening a
 * folder of eight CSVs has to work out how they relate; a single sheet reads
 * top to bottom in the order the return is filled in.
 */
export function buildPacketCsv(input: PacketInput): string {
  const L: string[] = [];
  const warnings = packetWarnings(input);
  const money = (c: number) => (c / 100).toFixed(2);

  L.push(`TAX PACKET ${input.taxYear}`);
  L.push(`Period,${input.from} to ${input.to} (end exclusive)`);
  L.push(`Accounting method,${escapeCsvCell(METHOD_LABELS[input.accountingMethod] ?? input.accountingMethod)}`);
  L.push(`Business type,${escapeCsvCell(ENTITY_LABELS[input.entityType] ?? input.entityType)}`);
  L.push(`Filing status,${escapeCsvCell(input.filingStatus.replace(/_/g, " "))}`);
  L.push(`EIN,${input.hasEin ? "the seller has one; write it here" : "none"}`);
  L.push(`Generated,${new Date().toISOString().slice(0, 10)}`);
  L.push("");

  if (warnings.length > 0) {
    L.push("READ THIS FIRST — FIGURES TO QUESTION");
    for (const w of warnings) {
      L.push(`${escapeCsvCell(w.headline)},${escapeCsvCell(w.detail)}`);
    }
    L.push("");
  }

  L.push("SCHEDULE C WORKSHEET");
  L.push("Line,Description,Amount");
  for (const r of scheduleCRows(input)) {
    L.push([r.line, escapeCsvCell(r.label), money(r.cents)].join(","));
  }
  L.push("");

  L.push("PART III — COST OF GOODS SOLD");
  if (input.cogs) {
    L.push("Line,Description,Amount");
    L.push(`35,Inventory at the start,${money(input.cogs.line_35_beginning_cents)}`);
    L.push(`36,Purchases,${money(input.cogs.line_36_purchases_cents)}`);
    L.push(`41,Inventory at the end,${money(input.cogs.line_41_ending_cents)}`);
    L.push(`42,Cost of goods sold,${money(input.cogs.line_42_cogs_cents)}`);
    L.push("");
    L.push(`Cross-check: cost basis of items sold,${money(input.cogs.sold_cost_basis_cents)}`);
    L.push(`Difference,${money(input.cogs.variance_cents)}`);
  } else {
    L.push("Not available — inventory was never counted for this period.");
  }
  L.push("");

  L.push("1099-K RECONCILIATION");
  if (input.bridges.length === 0) {
    L.push("No 1099-K entered for this year.");
  } else {
    L.push("Platform,Reported gross,Our gross,Difference,Sales counted");
    for (const b of input.bridges) {
      L.push(
        [
          escapeCsvCell(b.platform),
          b.reported_gross_cents === null ? "not entered" : money(b.reported_gross_cents),
          money(b.computed_gross_cents),
          money(b.variance_cents),
          String(b.sale_count),
        ].join(","),
      );
    }
  }
  L.push("");

  L.push("MILEAGE");
  if (input.mileage && input.mileage.trip_count > 0) {
    L.push(`Business miles,${input.mileage.total_miles}`);
    L.push(`Trips,${input.mileage.trip_count}`);
    L.push(`Deduction,${money(input.mileage.deduction_cents)}`);
    L.push(`Method,${input.vehicleYear?.method === "actual" ? "Actual expenses" : "Standard mileage rate"}`);
    L.push("");
    L.push("Part IV,Description,Miles");
    L.push(`44a,Business miles,${input.mileage.total_miles}`);
    L.push(`44b,Commuting miles,${input.vehicleYear?.commuting_miles ?? "not answered"}`);
    L.push(`44c,Other personal miles,${input.vehicleYear?.other_personal_miles ?? "not answered"}`);
    L.push(`,Total miles driven,${input.vehicleYear?.total_miles ?? "not answered"}`);
  } else {
    L.push("No trips logged for this year.");
  }
  L.push("");

  L.push("HOME OFFICE");
  if (input.homeOfficeCents > 0) {
    L.push(`Square feet,${input.homeOfficeSquareFeet ?? ""}`);
    L.push(`Months used,${input.homeOfficeMonths ?? ""}`);
    L.push(`Deduction (Schedule C line 30),${money(input.homeOfficeCents)}`);
    L.push("Method,Simplified");
  } else {
    L.push("Not claimed for this year.");
  }
  L.push("");

  L.push("INVENTORY AT THE END OF THE YEAR");
  if (input.snapshotTotalCents !== null) {
    L.push(`Items,${input.snapshotItemCount ?? ""}`);
    L.push(`Value,${money(input.snapshotTotalCents)}`);
    L.push(`Items with no purchase price,${input.snapshotItemsWithoutCost}`);
    L.push(`Counted on the day,${input.snapshotReconstructed ? "no — rebuilt afterwards" : "yes"}`);
  } else {
    L.push("Never counted.");
  }
  L.push("");

  if (input.reviewIssues.length > 0) {
    L.push("STILL ON THE REVIEW LIST");
    L.push("Kind,What,Date,Impact");
    for (const i of input.reviewIssues) {
      const impact =
        i.impact_cents !== null
          ? money(i.impact_cents)
          : i.estimated_impact_cents !== null
            ? `about ${money(i.estimated_impact_cents)}`
            : "unknown";
      L.push(
        [
          escapeCsvCell(i.kind.replace(/_/g, " ")),
          escapeCsvCell(i.title),
          i.happened_on,
          escapeCsvCell(impact),
        ].join(","),
      );
    }
    L.push("");
  }

  L.push(`Receipts included in this packet,${input.receiptCount}`);
  L.push("");
  L.push(
    escapeCsvCell(
      "GradeThread does the arithmetic on the seller's own records. It does not give tax advice, does not file anything, and takes no position on any judgement call. Every figure should be checked before it is filed.",
    ),
  );
  return L.join("\n");
}

/** What the packet does NOT contain, said on the cover rather than discovered. */
export const PACKET_EXCLUSIONS: readonly string[] = [
  "State and local tax of any kind. Everything here is federal.",
  "Self-employment tax and estimated payments. Those are on Schedule SE and Form 1040-ES, not Schedule C.",
  "Depreciation schedules. Equipment is listed at what it cost; whether it is expensed or depreciated is a decision for the preparer.",
  "Actual vehicle expenses. Only the standard mileage rate is worked out here.",
  "Form 8829. The home office figure uses the simplified method only.",
  "Anything the seller never recorded. This packet can only report what is in the books.",
];
