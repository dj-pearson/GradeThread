import type { ExpenseCategory } from "@/types/database";

// US-2983 — the chart of accounts, mirrored for the client.
//
// The database is the source of truth (migration 00684 seeds
// public.ledger_accounts). This file exists so a picker can show the IRS line
// beside a category name without a round trip, and so the labels are typed.
//
// The two CANNOT be allowed to drift, so chart-of-accounts.test.ts parses the
// migration's seed block and asserts this list matches it code for code, line
// for line. A mirror with no guard is a second source of truth pretending to be
// a cache.

export type AccountFlow =
  | "income"
  | "cogs"
  | "expense"
  | "vehicle"
  | "excluded"
  | "asset";

export interface LedgerAccount {
  code: string;
  name: string;
  flow: AccountFlow;
  /** Schedule C part: I income, II expenses, III COGS, IV vehicle. */
  schedule_c_part: string | null;
  schedule_c_line: string | null;
  /** The IRS's own wording, so a seller can find the line on the form. */
  schedule_c_label: string | null;
  /** Why this account reaches no line. Never null when there is no line. */
  no_line_reason: string | null;
  sort_order: number;
}

export const SYSTEM_ACCOUNTS: readonly LedgerAccount[] = [
  {
    code: "sales_revenue",
    name: "Item sales",
    flow: "income",
    schedule_c_part: "I",
    schedule_c_line: "1",
    schedule_c_label: "Gross receipts or sales",
    no_line_reason: null,
    sort_order: 100,
  },
  {
    code: "shipping_income",
    name: "Shipping the buyer paid",
    flow: "income",
    schedule_c_part: "I",
    schedule_c_line: "1",
    schedule_c_label: "Gross receipts or sales",
    no_line_reason: null,
    sort_order: 110,
  },
  {
    code: "other_income",
    name: "Other business income",
    flow: "income",
    schedule_c_part: "I",
    schedule_c_line: "6",
    schedule_c_label: "Other income",
    no_line_reason: null,
    sort_order: 120,
  },
  {
    code: "returns_allowances",
    name: "Refunds and returns",
    flow: "income",
    schedule_c_part: "I",
    schedule_c_line: "2",
    schedule_c_label: "Returns and allowances",
    no_line_reason: null,
    sort_order: 130,
  },
  {
    code: "sales_tax_collected",
    name: "Sales tax the marketplace collected",
    flow: "excluded",
    schedule_c_part: null,
    schedule_c_line: null,
    schedule_c_label: null,
    no_line_reason:
      "Collected and paid to the state by the marketplace under facilitator law. It was never your income, so it appears on no line of your return -- but it IS inside the gross figure on your 1099-K.",
    sort_order: 140,
  },
  {
    code: "inventory_beginning",
    name: "Inventory at the start of the year",
    flow: "cogs",
    schedule_c_part: "III",
    schedule_c_line: "35",
    schedule_c_label: "Inventory at beginning of year",
    no_line_reason: null,
    sort_order: 200,
  },
  {
    code: "purchases",
    name: "What you paid for the items",
    flow: "cogs",
    schedule_c_part: "III",
    schedule_c_line: "36",
    schedule_c_label:
      "Purchases less cost of items withdrawn for personal use",
    no_line_reason: null,
    sort_order: 210,
  },
  {
    code: "cogs_labor",
    name: "Labour that went into the goods",
    flow: "cogs",
    schedule_c_part: "III",
    schedule_c_line: "37",
    schedule_c_label: "Cost of labor",
    no_line_reason: null,
    sort_order: 220,
  },
  {
    code: "cogs_materials",
    name: "Materials and supplies in the goods",
    flow: "cogs",
    schedule_c_part: "III",
    schedule_c_line: "38",
    schedule_c_label: "Materials and supplies",
    no_line_reason: null,
    sort_order: 230,
  },
  {
    code: "cogs_other",
    name: "Other costs of the goods",
    flow: "cogs",
    schedule_c_part: "III",
    schedule_c_line: "39",
    schedule_c_label: "Other costs",
    no_line_reason: null,
    sort_order: 240,
  },
  {
    code: "inventory_ending",
    name: "Inventory at the end of the year",
    flow: "cogs",
    schedule_c_part: "III",
    schedule_c_line: "41",
    schedule_c_label: "Inventory at end of year",
    no_line_reason: null,
    sort_order: 250,
  },
  {
    code: "advertising",
    name: "Advertising and promoted listings",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "8",
    schedule_c_label: "Advertising",
    no_line_reason: null,
    sort_order: 300,
  },
  {
    code: "vehicle_mileage",
    name: "Driving for the business",
    flow: "vehicle",
    schedule_c_part: "II",
    schedule_c_line: "9",
    schedule_c_label: "Car and truck expenses",
    no_line_reason: null,
    sort_order: 310,
  },
  {
    code: "platform_fees",
    name: "Selling fees",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "10",
    schedule_c_label: "Commissions and fees",
    no_line_reason: null,
    sort_order: 320,
  },
  {
    code: "depreciation",
    name: "Equipment",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "13",
    schedule_c_label: "Depreciation and section 179 expense deduction",
    no_line_reason: null,
    sort_order: 330,
  },
  {
    code: "insurance",
    name: "Business insurance",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "15",
    schedule_c_label: "Insurance (other than health)",
    no_line_reason: null,
    sort_order: 340,
  },
  {
    code: "interest_other",
    name: "Business loan or card interest",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "16b",
    schedule_c_label: "Interest -- other",
    no_line_reason: null,
    sort_order: 350,
  },
  {
    code: "professional_services",
    name: "Accountant and legal",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "17",
    schedule_c_label: "Legal and professional services",
    no_line_reason: null,
    sort_order: 360,
  },
  {
    code: "office_expense",
    name: "Office expense",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "18",
    schedule_c_label: "Office expense",
    no_line_reason: null,
    sort_order: 370,
  },
  {
    code: "rent_equipment",
    name: "Equipment rental",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "20a",
    schedule_c_label: "Rent or lease -- vehicles, machinery, and equipment",
    no_line_reason: null,
    sort_order: 380,
  },
  {
    code: "rent_property",
    name: "Storage unit or rented space",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "20b",
    schedule_c_label: "Rent or lease -- other business property",
    no_line_reason: null,
    sort_order: 390,
  },
  {
    code: "repairs",
    name: "Repairs and maintenance",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "21",
    schedule_c_label: "Repairs and maintenance",
    no_line_reason: null,
    sort_order: 400,
  },
  {
    code: "supplies",
    name: "Shipping supplies",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "22",
    schedule_c_label: "Supplies",
    no_line_reason: null,
    sort_order: 410,
  },
  {
    code: "taxes_licenses",
    name: "Business taxes and licences",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "23",
    schedule_c_label: "Taxes and licenses",
    no_line_reason: null,
    sort_order: 420,
  },
  {
    code: "sales_tax_remitted",
    name: "Sales tax you collected and paid over",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "23",
    schedule_c_label: "Taxes and licenses",
    no_line_reason: null,
    sort_order: 425,
  },
  {
    code: "travel",
    name: "Travel away from home",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "24a",
    schedule_c_label: "Travel",
    no_line_reason: null,
    sort_order: 430,
  },
  {
    code: "meals",
    name: "Business meals",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "24b",
    schedule_c_label: "Deductible meals",
    no_line_reason: null,
    sort_order: 440,
  },
  {
    code: "utilities",
    name: "Utilities",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "25",
    schedule_c_label: "Utilities",
    no_line_reason: null,
    sort_order: 450,
  },
  {
    code: "shipping_postage",
    name: "Postage and labels",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "27a",
    schedule_c_label: "Other expenses",
    no_line_reason: null,
    sort_order: 460,
  },
  {
    code: "software_subscriptions",
    name: "Software and subscriptions",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "27a",
    schedule_c_label: "Other expenses",
    no_line_reason: null,
    sort_order: 470,
  },
  {
    code: "home_office",
    name: "Home office",
    flow: "expense",
    schedule_c_part: "II",
    schedule_c_line: "30",
    schedule_c_label: "Expenses for business use of your home",
    no_line_reason: null,
    sort_order: 480,
  },
  {
    code: "cash_payout",
    name: "Money that reached your bank",
    flow: "asset",
    schedule_c_part: null,
    schedule_c_line: null,
    schedule_c_label: null,
    no_line_reason:
      "A deposit moves money you already earned from the marketplace into your bank. Counting it again would double your income, so it reaches no line on your return -- but it is what your bank statement shows, which is why the books keep it.",
    sort_order: 500,
  },
  {
    code: "uncategorised",
    name: "Not sorted yet",
    flow: "expense",
    schedule_c_part: null,
    schedule_c_line: null,
    schedule_c_label: null,
    no_line_reason:
      "Nothing here reaches your return until you say what it was. We will not guess a deduction on your behalf.",
    sort_order: 900,
  },
];

const BY_CODE = new Map(SYSTEM_ACCOUNTS.map((a) => [a.code, a]));

export function accountByCode(code: string): LedgerAccount | undefined {
  return BY_CODE.get(code);
}

/**
 * The default account for each of the eight expense categories.
 *
 * Mirrors public.default_account_for_category() in migration 00684. Two of
 * these are judgement calls rather than arithmetic, and both are recorded here
 * so nobody has to re-derive them:
 *
 * - `equipment` goes to DEPRECIATION (line 13), not supplies. Whether a camera
 *   or a steamer is expensed outright or depreciated is a threshold question
 *   only the seller's accountant can settle, and defaulting to supplies would
 *   quietly take the aggressive position on their behalf.
 * - `subscriptions` goes to OTHER EXPENSES (27a), not office expense (18).
 *   Both are defensible and preparers split roughly evenly. 27a wins because it
 *   is itemised and labelled on the form, so the accountant can see what it is.
 */
export const CATEGORY_DEFAULT_ACCOUNT: Record<ExpenseCategory, string> = {
  shipping_supplies: "supplies",
  mileage: "vehicle_mileage",
  subscriptions: "software_subscriptions",
  platform_fees: "platform_fees",
  sourcing_travel: "travel",
  equipment: "depreciation",
  storage: "rent_property",
  other: "uncategorised",
};

/** The account an expense actually lands on: its explicit choice, else the category default. */
export function resolveExpenseAccount(
  category: ExpenseCategory,
  explicitCode: string | null,
): LedgerAccount | undefined {
  return accountByCode(explicitCode ?? CATEGORY_DEFAULT_ACCOUNT[category]);
}

/**
 * "Line 22 (Supplies)", or null when the account reaches no line.
 *
 * Returning null rather than a placeholder is the point of AC3: an
 * uncategorised dollar must look uncategorised.
 */
export function scheduleCTag(account: LedgerAccount | undefined): string | null {
  if (!account?.schedule_c_line) return null;
  return account.schedule_c_label
    ? `Line ${account.schedule_c_line} (${account.schedule_c_label})`
    : `Line ${account.schedule_c_line}`;
}

/** Accounts a seller may file an expense against, in form order. */
export const EXPENSE_ACCOUNTS: readonly LedgerAccount[] = SYSTEM_ACCOUNTS.filter(
  (a) => a.flow === "expense" || a.flow === "vehicle",
);
