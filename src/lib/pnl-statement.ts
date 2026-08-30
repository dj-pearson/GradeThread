import { SYSTEM_ACCOUNTS, type LedgerAccount } from "@/lib/chart-of-accounts";

// US-2985 — the profit and loss statement.
//
// finances.tsx has KPI tiles and six charts. Neither is an income statement,
// which is the one document an accountant, a lender or a buyer asks for by
// name. Charts answer "how am I trending". A P&L answers "what were my
// numbers", in the row order a preparer reads down.
//
// NOT src/lib/pnl.ts, which already exists and is a different thing: that one
// computes a single sale's margin from a SaleRow. This one aggregates ledger
// entries into a statement. Two files because they are two questions -- "did
// this flip make money" and "what were my numbers this quarter".
//
// Everything here is pure. It takes rows and returns a statement; it does no
// fetching, knows nothing about React, and is tested without a database. That
// is deliberate: US-2984's whole point was that three code paths each derived
// their own totals, and a builder that could quietly re-derive would put a
// fourth one back.

/** One ledger row, reduced to what a statement needs. */
export interface StatementEntry {
  /** The account code, e.g. "sales_revenue". */
  account: string;
  /** Signed integer cents. Positive increases profit. */
  amount_cents: number;
}

export interface StatementLine {
  code: string;
  label: string;
  /**
   * Signed cents as stored. A cost is NEGATIVE here even though the statement
   * prints it under a subtracted heading -- keeping the sign means every total
   * is a plain sum and nobody has to remember which rows to flip.
   */
  cents: number;
  scheduleCLine: string | null;
  scheduleCLabel: string | null;
  /** Set when the account reaches no line, so the row can explain itself. */
  noLineReason: string | null;
}

export type StatementSectionKey =
  | "income"
  | "returns"
  | "cogs"
  | "expenses"
  | "home_office"
  | "excluded";

export interface StatementSection {
  key: StatementSectionKey;
  title: string;
  lines: StatementLine[];
  /** Sum of the section's lines, signed. */
  cents: number;
}

export interface PnlStatement {
  sections: StatementSection[];
  grossReceiptsCents: number;
  returnsCents: number;
  netRevenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  /** Schedule C line 28. Lines 8 to 27 ONLY -- home office is not among them. */
  operatingExpensesCents: number;
  /** Schedule C line 29: gross profit less line 28, before the home office. */
  tentativeProfitCents: number;
  /** Schedule C line 30, which the form keeps separate from line 28. */
  homeOfficeCents: number;
  netProfitCents: number;
  /** Recorded, and deliberately in none of the totals above. */
  excludedCents: number;
  entryCount: number;
}

const BY_CODE = new Map(SYSTEM_ACCOUNTS.map((a) => [a.code, a]));

// Which section an account belongs to. Driven off the chart's `flow` rather
// than a second list of codes, so a new account lands somewhere without editing
// this file. The failure mode otherwise is an account that exists, collects
// entries and appears in no section -- which reads as a balanced statement
// quietly missing money.
function sectionFor(account: LedgerAccount): StatementSectionKey | null {
  if (account.code === "returns_allowances") return "returns";
  // US-2990. The home office is Schedule C LINE 30, and the form keeps it out
  // of line 28. Folding it into running costs would put it inside a subtotal it
  // does not belong to, and a seller transcribing line 28 off this statement
  // would overstate it by the whole deduction.
  if (account.code === "home_office") return "home_office";
  switch (account.flow) {
    case "income":
      return "income";
    case "cogs":
      return "cogs";
    case "expense":
    case "vehicle":
      return "expenses";
    case "excluded":
    case "asset":
      return "excluded";
    default:
      return null;
  }
}

const SECTION_TITLES: Record<StatementSectionKey, string> = {
  income: "What came in",
  returns: "Refunds and returns",
  cogs: "What the items cost you",
  expenses: "What it cost to run",
  home_office: "Working from home",
  excluded: "Money that passed through",
};

/**
 * Accounts that print even with no entries, because their absence is
 * information.
 *
 * A statement with no COGS row does not say "you had no cost of goods", it says
 * nothing, and the seller cannot tell a zero from a gap. These three are the
 * spine of Schedule C Part I and Part III.
 */
const ALWAYS_SHOWN: readonly string[] = [
  "sales_revenue",
  "returns_allowances",
  "purchases",
];

/**
 * Build the statement.
 *
 * Rows come out in the chart's `sort_order`, which is Schedule C order: income,
 * then Part III, then Part II lines 8 through 30. Never alphabetical -- a
 * preparer reads down the form, and an alphabetised statement makes them hunt.
 */
export function buildStatement(
  entries: readonly StatementEntry[],
): PnlStatement {
  const totals = new Map<string, number>();
  for (const code of ALWAYS_SHOWN) totals.set(code, 0);

  let unplaced = 0;
  for (const e of entries) {
    if (!BY_CODE.has(e.account)) {
      // An entry against an account the chart does not know. Counted so the
      // caller can see it rather than silently dropped: a statement that
      // quietly loses a row is worse than one admitting it cannot place it.
      unplaced += e.amount_cents;
      continue;
    }
    totals.set(e.account, (totals.get(e.account) ?? 0) + e.amount_cents);
  }

  const buckets = new Map<StatementSectionKey, StatementLine[]>();
  for (const account of SYSTEM_ACCOUNTS) {
    const cents = totals.get(account.code);
    if (cents === undefined) continue;
    const key = sectionFor(account);
    if (!key) continue;
    const line: StatementLine = {
      code: account.code,
      label: account.name,
      cents,
      scheduleCLine: account.schedule_c_line,
      scheduleCLabel: account.schedule_c_label,
      noLineReason: account.no_line_reason,
    };
    const list = buckets.get(key);
    if (list) list.push(line);
    else buckets.set(key, [line]);
  }

  if (unplaced !== 0) {
    const list = buckets.get("expenses") ?? [];
    list.push({
      code: "__unplaced",
      label: "Entries we could not place",
      cents: unplaced,
      scheduleCLine: null,
      scheduleCLabel: null,
      noLineReason:
        "These entries point at an account this statement does not recognise. They are shown so the total is honest, but they reach no line until someone sorts them.",
    });
    buckets.set("expenses", list);
  }

  const order: StatementSectionKey[] = [
    "income",
    "returns",
    "cogs",
    "expenses",
    "home_office",
    "excluded",
  ];
  const sections: StatementSection[] = order
    .map((key) => {
      const lines = buckets.get(key) ?? [];
      return {
        key,
        title: SECTION_TITLES[key],
        lines,
        cents: lines.reduce((s, l) => s + l.cents, 0),
      };
    })
    .filter((s) => s.lines.length > 0);

  const sectionTotal = (key: StatementSectionKey) =>
    sections.find((s) => s.key === key)?.cents ?? 0;

  const grossReceiptsCents = sectionTotal("income");
  const returnsCents = sectionTotal("returns");
  const netRevenueCents = grossReceiptsCents + returnsCents;
  const cogsCents = sectionTotal("cogs");
  const grossProfitCents = netRevenueCents + cogsCents;
  const operatingExpensesCents = sectionTotal("expenses");
  const tentativeProfitCents = grossProfitCents + operatingExpensesCents;
  const homeOfficeCents = sectionTotal("home_office");
  const netProfitCents = tentativeProfitCents + homeOfficeCents;

  return {
    sections,
    grossReceiptsCents,
    returnsCents,
    netRevenueCents,
    cogsCents,
    grossProfitCents,
    operatingExpensesCents,
    tentativeProfitCents,
    homeOfficeCents,
    netProfitCents,
    excludedCents: sectionTotal("excluded"),
    entryCount: entries.length,
  };
}

/** The subtotal rows, in print order, each naming the form line it feeds. */
export interface StatementTotalRow {
  key: string;
  label: string;
  cents: number;
  /** True for the rows a reader's eye should stop on. */
  emphasis: boolean;
  hint: string | null;
}

export function statementTotals(p: PnlStatement): StatementTotalRow[] {
  return [
    {
      key: "gross_receipts",
      label: "Gross receipts",
      cents: p.grossReceiptsCents,
      emphasis: false,
      hint: "Schedule C line 1",
    },
    {
      key: "returns",
      label: "Less refunds and returns",
      cents: p.returnsCents,
      emphasis: false,
      hint: "Schedule C line 2",
    },
    {
      key: "net_revenue",
      label: "Net revenue",
      cents: p.netRevenueCents,
      emphasis: false,
      hint: "Schedule C line 3",
    },
    {
      key: "cogs",
      label: "Cost of goods sold",
      cents: p.cogsCents,
      emphasis: false,
      hint: "Schedule C line 4, carried from Part III",
    },
    {
      key: "gross_profit",
      label: "Gross profit",
      cents: p.grossProfitCents,
      emphasis: true,
      hint: "Schedule C line 5",
    },
    {
      key: "operating_expenses",
      label: "Running costs",
      cents: p.operatingExpensesCents,
      emphasis: false,
      hint: "Schedule C line 28",
    },
    // Lines 29 and 30 only appear when there IS a home office. On a statement
    // with none, "tentative profit" and "net profit" are the same number, and
    // printing both invites a seller to wonder which one they are taxed on.
    ...(p.homeOfficeCents !== 0
      ? [
          {
            key: "tentative_profit",
            label: "Profit before the home office",
            cents: p.tentativeProfitCents,
            emphasis: false,
            hint: "Schedule C line 29",
          },
          {
            key: "home_office",
            label: "Working from home",
            cents: p.homeOfficeCents,
            emphasis: false,
            hint: "Schedule C line 30",
          },
        ]
      : []),
    {
      key: "net_profit",
      label: "Net profit",
      cents: p.netProfitCents,
      emphasis: true,
      hint: "Schedule C line 31, which is what you are taxed on",
    },
  ];
}

export interface StatementDelta {
  cents: number;
  /** Null when the prior period was zero: a percentage against nothing is not a number. */
  percent: number | null;
}

/**
 * This period against the last one.
 *
 * Returns a null percent when the prior figure is zero, rather than Infinity or
 * 100%. Going from $0 to $500 is not a 100% rise, and printing one is a lie the
 * seller will repeat to somebody.
 */
export function statementDelta(
  current: number,
  prior: number,
): StatementDelta {
  const cents = current - prior;
  if (prior === 0) return { cents, percent: null };
  return { cents, percent: (cents / Math.abs(prior)) * 100 };
}
