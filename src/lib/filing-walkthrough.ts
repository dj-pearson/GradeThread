import type { MoneyView } from "@/pages/flipdesk/nav-tabs";

// US-3137 — the filing walkthrough.
//
// The epic built every number a Schedule C needs. What it never built was an
// ORDER. A seller arriving in March met a tax page with seven cards on it, each
// correct, none of them saying which to do first or what happens if they skip
// one — and the packet, which is the thing they actually want, sat at the
// bottom quietly producing a worksheet full of caveats because five of the
// other cards were never opened.
//
// So this is the order, stated once, with each step reading the books to work
// out whether it is already done. It is a CHECKLIST, not a wizard: nothing here
// blocks, nothing is mandatory, and a seller who wants only the packet can
// still take only the packet. The steps that were skipped then show up as the
// caveats on its cover, which is the same information arriving too late to act
// on. This is that information arriving early.
//
// WHAT IT IS NOT. It does not file, does not fill a form, does not ask for an
// SSN or an EIN, and stores nothing new — every status below is derived from
// rows the seller already has. The epic's four refusals are written up in
// vault/50-business/books-and-taxes.md and apply here unchanged. The framing
// constant at the bottom of this file goes ON the screen, not in a tooltip: a
// page listing IRS form numbers has to say plainly what it is and is not.

export type StepStatus = "done" | "needs_you" | "not_started" | "not_applicable";

export interface FilingStep {
  key: string;
  /** Imperative, in the seller's words. */
  title: string;
  /** One line on why it matters. Never two. */
  why: string;
  /** The Schedule C (or other form) lines this step feeds. */
  formLines: string[];
  status: StepStatus;
  /** What goes wrong on the return if this is left as it is. Null when done. */
  ifSkipped: string | null;
  /** Where in Money the seller does it. */
  view: MoneyView;
  /** Shown under the title when there is something concrete to say. */
  detail: string | null;
}

/**
 * Everything the walkthrough needs, and nothing it does not.
 *
 * Deliberately flat and cheap. The tax packet's own `gather()` makes a dozen
 * round trips and takes seconds, which is right for a download the seller asked
 * for and wrong for a checklist that has to render on arrival. Every field here
 * is a count, a boolean or a small number — a page of them is one screenful of
 * queries, not a report build.
 */
export interface FilingSignals {
  taxYear: number;
  /** True once the seller has saved the tax profile at least once. */
  profileSaved: boolean;
  entityType: string;
  accountingMethod: string;
  hasEin: boolean;
  /** Open items on the books-health review queue for the year. */
  reviewIssueCount: number;
  /** Expenses over the receipt threshold with no receipt attached. */
  expensesWithoutReceipt: number;
  /** An inventory snapshot exists dated the first day of the year. */
  openingSnapshot: boolean;
  /** An inventory snapshot exists dated the first day of the NEXT year. */
  closingSnapshot: boolean;
  /** Items in the closing snapshot with no purchase price on them. */
  snapshotItemsWithoutCost: number;
  /** Marketplaces with sales in the year, so a 1099-K may be coming. */
  platformsWithSales: number;
  /** Platforms whose 1099-K figure the seller has entered. */
  bridgesEntered: number;
  /** Entered bridges whose reported gross disagrees with the books. */
  bridgesWithVariance: number;
  tripCount: number;
  /** The Part IV vehicle questions have been answered for the year. */
  vehicleAnswered: boolean;
  /** The home-office question has an answer, INCLUDING an explicit no. */
  homeOfficeAnswered: boolean;
  homeOfficeClaimed: boolean;
  /** Estimated-tax payments recorded for the year. */
  paymentsRecorded: number;
  /** Instalment dates for the year that have already passed. */
  duePeriodsElapsed: number;
  /** The year has been closed, which locks it and takes the snapshot. */
  periodClosed: boolean;
}

/** The receipt threshold the books-health queue already uses. */
export const RECEIPT_THRESHOLD_DOLLARS = 75;

/**
 * The steps, in the order they should be done.
 *
 * ORDER IS THE PRODUCT HERE. Inventory before the packet because the packet
 * cannot compute line 42 without it. The review list early because resolving an
 * issue moves numbers every later step reads. Closing the year second to last
 * because closing takes the snapshot, and closing before the corrections are in
 * means reopening. The packet last because it is a print of everything above.
 */
export function filingSteps(s: FilingSignals): FilingStep[] {
  const steps: FilingStep[] = [];

  steps.push({
    key: "profile",
    title: "Tell us how you file",
    why: "Everything below reads the wrong twelve months until this is set.",
    formLines: ["Schedule C header"],
    status: s.profileSaved ? "done" : "not_started",
    ifSkipped: s.profileSaved
      ? null
      : "We assume sole proprietor, cash method, calendar year. Right for most resellers and wrong for some, and nothing on this page says which you are.",
    view: "tax",
    detail: s.profileSaved
      ? labelEntity(s.entityType) + ", " + labelMethod(s.accountingMethod)
      : null,
  });

  steps.push({
    key: "review",
    title: "Clear the review list",
    why: "Each item on it is a number that is wrong somewhere on the return.",
    formLines: ["Part I", "Part II"],
    status: s.reviewIssueCount === 0 ? "done" : "needs_you",
    ifSkipped:
      s.reviewIssueCount === 0
        ? null
        : "These carry through into every figure below, so doing them later means redoing the steps after this one.",
    view: "pnl",
    detail:
      s.reviewIssueCount === 0
        ? "Nothing unexplained in this year's books."
        : s.reviewIssueCount + " thing(s) the books flagged and nobody answered.",
  });

  steps.push({
    key: "receipts",
    title: "Attach the missing receipts",
    why:
      "Deductions over $" +
      RECEIPT_THRESHOLD_DOLLARS +
      " are the ones that need evidence if anyone asks.",
    formLines: ["Part II"],
    status: s.expensesWithoutReceipt === 0 ? "done" : "needs_you",
    ifSkipped:
      s.expensesWithoutReceipt === 0
        ? null
        : "The deductions are not necessarily wrong. They are the ones you could not evidence.",
    view: "expenses",
    detail:
      s.expensesWithoutReceipt === 0
        ? "Every expense over the threshold has a receipt."
        : s.expensesWithoutReceipt +
          " expense(s) over $" +
          RECEIPT_THRESHOLD_DOLLARS +
          " have no receipt.",
  });

  steps.push({
    key: "mileage",
    title: "Finish the mileage log",
    why: "The standard mileage deduction needs a dated log, not a total.",
    formLines: ["Line 9", "Part IV"],
    status:
      s.tripCount === 0
        ? "not_applicable"
        : s.vehicleAnswered
          ? "done"
          : "needs_you",
    ifSkipped:
      s.tripCount === 0
        ? null
        : s.vehicleAnswered
          ? null
          : "Part IV asks for your commuting and personal miles. They cannot be worked out from the business trips, so nobody can answer them but you.",
    view: "deductions",
    detail:
      s.tripCount === 0
        ? "No trips logged this year. Nothing to claim, and nothing to answer."
        : s.tripCount + " trip(s) logged.",
  });

  steps.push({
    key: "home_office",
    title: "Answer the home-office question",
    why: "Whether a room is used only for the business is a fact only you know.",
    formLines: ["Line 30"],
    status: s.homeOfficeAnswered ? "done" : "not_started",
    ifSkipped: s.homeOfficeAnswered
      ? null
      : "Line 30 comes out blank. That is the right answer for plenty of sellers and the wrong one for anyone with a dedicated space.",
    view: "deductions",
    detail: s.homeOfficeAnswered
      ? s.homeOfficeClaimed
        ? "Claimed, simplified method."
        : "Answered: not claiming one."
      : null,
  });

  steps.push({
    key: "inventory",
    title: "Count what you were holding at both ends of the year",
    why: "Part III cannot produce a cost of goods sold without both figures.",
    formLines: ["Line 35", "Line 41", "Line 42"],
    status:
      s.openingSnapshot && s.closingSnapshot
        ? s.snapshotItemsWithoutCost > 0
          ? "needs_you"
          : "done"
        : "not_started",
    ifSkipped:
      s.openingSnapshot && s.closingSnapshot
        ? s.snapshotItemsWithoutCost > 0
          ? "Items valued at zero make closing inventory too small and cost of goods sold too large."
          : null
        : "Line 42 becomes arithmetic on a gap. It gets worse with time: once you edit an item's cost, that year's figure is gone for good.",
    view: "pnl",
    detail: inventoryDetail(s),
  });

  steps.push({
    key: "form1099k",
    title: "Enter each 1099-K you were sent",
    why: "The gross a marketplace reports includes shipping and sales tax, so it never matches your profit.",
    formLines: ["Line 1"],
    status:
      s.platformsWithSales === 0
        ? "not_applicable"
        : s.bridgesEntered === 0
          ? "not_started"
          : s.bridgesWithVariance > 0
            ? "needs_you"
            : "done",
    ifSkipped:
      s.platformsWithSales === 0
        ? null
        : s.bridgesEntered === 0
          ? "The IRS has a number for your year and you have a different one. Nothing here explains the gap until you enter theirs."
          : s.bridgesWithVariance > 0
            ? "A gap between the two usually means sales missing from these books, or the platform counting something we did not."
            : null,
    view: "tax",
    detail: bridgeDetail(s),
  });

  steps.push({
    key: "estimated",
    title: "Record what you paid in estimated tax",
    why: "Payments are personal, so nothing in the books knows about them until you say.",
    formLines: ["Form 1040-ES"],
    status:
      s.duePeriodsElapsed === 0
        ? "not_applicable"
        : s.paymentsRecorded >= s.duePeriodsElapsed
          ? "done"
          : "needs_you",
    ifSkipped:
      s.duePeriodsElapsed === 0
        ? null
        : s.paymentsRecorded >= s.duePeriodsElapsed
          ? null
          : "The running figure on this page will keep telling you you are behind on installments you have already paid.",
    view: "tax",
    detail:
      s.duePeriodsElapsed === 0
        ? "No installment dates have passed yet for " + s.taxYear + "."
        : s.paymentsRecorded +
          " of " +
          s.duePeriodsElapsed +
          " passed installment date(s) have a payment recorded.",
  });

  steps.push({
    key: "close",
    title: "Close the year",
    why: "Closing locks the year and takes the inventory count on the day.",
    formLines: ["Part III"],
    status: s.periodClosed ? "done" : "not_started",
    ifSkipped: s.periodClosed
      ? null
      : "The year stays editable, so a figure you hand your accountant in March can quietly change in April.",
    view: "pnl",
    detail: s.periodClosed
      ? s.taxYear + " is closed. Reopening it is one click and leaves a record."
      : null,
  });

  // Read off the steps ALREADY BUILT, never by calling back into this function.
  // The recursive version of this looked fine and never returned.
  const everythingAboveIsAnswered = steps.every(
    (step) => step.status === "done" || step.status === "not_applicable",
  );

  steps.push({
    key: "packet",
    title: "Download the packet and hand it over",
    why: "One file with the worksheet, the receipts and every caveat on the cover.",
    formLines: ["Schedule C", "Schedule SE"],
    // Never "done": the packet is a print, and it is correct to take it more
    // than once. Marking it done would imply the year was finished by
    // downloading a file, which is the one thing this page must not imply.
    status: everythingAboveIsAnswered ? "needs_you" : "not_started",
    ifSkipped: everythingAboveIsAnswered
      ? null
      : "You can take the packet now. Anything above that is still open turns into a caveat on its cover instead.",
    view: "tax",
    detail: everythingAboveIsAnswered
      ? "Everything above is answered."
      : "Take it whenever you like. It says what it could not answer.",
  });

  return steps;
}

function inventoryDetail(s: FilingSignals): string | null {
  if (!s.openingSnapshot && !s.closingSnapshot) return "Neither end counted.";
  if (!s.openingSnapshot) return "The start of the year was never counted.";
  if (!s.closingSnapshot) return "The end of the year was never counted.";
  if (s.snapshotItemsWithoutCost > 0) {
    return s.snapshotItemsWithoutCost + " item(s) on hand have no purchase price.";
  }
  return "Both ends counted.";
}

function bridgeDetail(s: FilingSignals): string | null {
  if (s.platformsWithSales === 0) return "No marketplace sales this year.";
  if (s.bridgesEntered === 0) {
    return s.platformsWithSales + " marketplace(s) sold for you this year.";
  }
  if (s.bridgesWithVariance > 0) {
    return s.bridgesWithVariance + " of them disagree with these books.";
  }
  return s.bridgesEntered + " entered and reconciled.";
}

export interface FilingProgress {
  done: number;
  /** Steps that count — a not-applicable step is neither done nor outstanding. */
  total: number;
  /** The first step that is not done. Null when everything is. */
  next: FilingStep | null;
}

export function filingProgress(steps: FilingStep[]): FilingProgress {
  const counted = steps.filter(
    (s) => s.status !== "not_applicable" && s.key !== "packet",
  );
  return {
    done: counted.filter((s) => s.status === "done").length,
    total: counted.length,
    next:
      steps.find(
        (s) => s.status === "needs_you" || s.status === "not_started",
      ) ?? null,
  };
}

/** One form the seller will end up filing, and what it is for. */
export interface FormToFile {
  form: string;
  what: string;
  /** Why this seller in particular gets it. */
  because: string;
}

/**
 * What actually gets filed, given how this seller is set up.
 *
 * Named rather than produced. This is the list a reseller cannot find a
 * straight answer to anywhere, and naming it is not advice: which forms a sole
 * proprietor with a profit files is a matter of public record, and every entry
 * says why it is on the list so a seller can tell when it stops applying.
 */
export function formsToFile(s: FilingSignals): FormToFile[] {
  const out: FormToFile[] = [];

  if (s.entityType === "sole_prop" || s.entityType === "single_member_llc") {
    out.push({
      form: "Schedule C",
      what: "Profit or loss from the business. The worksheet in your packet fills this in.",
      because:
        s.entityType === "single_member_llc"
          ? "A single-member LLC is reported on the owner's own return unless it elected otherwise."
          : "You file as a sole proprietor.",
    });
    out.push({
      form: "Schedule SE",
      what: "Self-employment tax: Social Security and Medicare on the profit.",
      because:
        "It follows Schedule C whenever the business made money. The packet works the figure out but does not lay out this form.",
    });
    out.push({
      form: "Form 1040",
      what: "Your own return. Both schedules attach to it.",
      because: "The business does not file separately from you.",
    });
  } else {
    out.push({
      form: "Not Schedule C",
      what:
        labelEntity(s.entityType) +
        " does not report on Schedule C. Your preparer will know which return applies.",
      because:
        "The packet's figures are still the right figures. Only the form they go on changes.",
    });
  }

  if (s.tripCount > 0) {
    out.push({
      form: "Schedule C Part IV",
      what: "The vehicle questions. Part of Schedule C, not a separate form.",
      because: "You logged mileage this year.",
    });
  }

  if (s.duePeriodsElapsed > 0) {
    out.push({
      form: "Form 1040-ES",
      what: "Next year's estimated payments, four times a year.",
      because:
        "Tax on business profit is not withheld by anyone, so it is paid as you go.",
    });
  }

  return out;
}

/**
 * The framing, once, in the same words the content module uses.
 *
 * On the screen, not in a tooltip. A page that lists IRS form numbers has to
 * say plainly what it is and is not, and the seller should not have to hover to
 * find that out.
 */
export const FILING_FRAMING =
  "This walks you through your own records and names the line each figure belongs on. It is not tax advice, it does not file anything, and it never asks for your SSN or EIN. Check every figure before it goes on a return.";

const ENTITY_LABELS: Record<string, string> = {
  sole_prop: "Sole proprietor",
  single_member_llc: "Single-member LLC",
  multi_member_llc: "Multi-member LLC",
  partnership: "Partnership",
  s_corp: "S corporation",
  c_corp: "C corporation",
};

const METHOD_LABELS: Record<string, string> = {
  cash: "cash method",
  accrual: "accrual method",
};

function labelEntity(v: string): string {
  return ENTITY_LABELS[v] ?? v;
}

function labelMethod(v: string): string {
  return METHOD_LABELS[v] ?? v;
}
