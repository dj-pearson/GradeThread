import { SYSTEM_ACCOUNTS, type LedgerAccount } from "@/lib/chart-of-accounts";

// US-2997 — mapping GradeThread's chart of accounts onto a QuickBooks Online
// company file.
//
// THIS IS WHERE THE INTEGRATION SUCCEEDS OR FAILS. Pushing a sale into the
// wrong QBO account produces a mess an accountant unpicks by hand, and QBO has
// no undo for a bulk sync. So the mapping is proposed, shown, and validated
// against the company's LIVE chart before a single transaction moves. Nothing
// here talks to the network: it takes a chart of accounts that was fetched
// elsewhere and answers questions about it.
//
// The vocabulary is Intuit's, not ours. A QBO account has a `Classification`
// (Revenue / Expense / Asset / Liability / Equity), an `AccountType`
// ("Income", "Cost of Goods Sold", "Expense", "Other Expense", "Bank"), and an
// `AccountSubType` ("SalesOfProductIncome", "SuppliesMaterialsCogs", and about
// ninety more). Matching on SubType is precise; matching on Type is a guess
// that is usually right; matching on name is a guess that is usually wrong,
// because a seller renames accounts.

export interface QboAccount {
  Id: string;
  Name: string;
  /** Present on most accounts. Absent on a few Intuit-managed ones. */
  AccountType?: string;
  AccountSubType?: string;
  Classification?: string;
  Active?: boolean;
  FullyQualifiedName?: string;
}

export interface MappingProposal {
  /** GradeThread account code, from SYSTEM_ACCOUNTS. */
  code: string;
  /** The QBO account we propose, or null when nothing in the file fits. */
  qboId: string | null;
  qboName: string | null;
  /** How we arrived at it, shown in the UI so the seller can judge it. */
  basis: "subtype" | "type" | "name" | "none" | "not_needed";
  /** Plain-English reason, always set when qboId is null. */
  note: string | null;
}

export type MappingChoice = Record<string, string | null>;

export interface MappingProblem {
  code: string;
  /** What is wrong, in the seller's words. */
  message: string;
  /** True when this blocks only its own account's push, which is all of them. */
  blocksOnlyThisAccount: true;
}

/**
 * What each GradeThread account should look for in a QBO chart.
 *
 * `subTypes` is tried in order, then `types`, then a case-insensitive name
 * contains. `needed: false` means the account never posts to QBO at all --
 * saying so explicitly is better than leaving the seller to wonder why a row
 * has no picker.
 */
interface Target {
  subTypes: string[];
  types: string[];
  names: string[];
  needed: boolean;
  /** Why it is not needed. Required whenever needed is false. */
  skipReason?: string;
}

const TARGETS: Record<string, Target> = {
  // ---- Income (Schedule C Part I) -----------------------------------------
  sales_revenue: {
    subTypes: ["SalesOfProductIncome"],
    types: ["Income"],
    names: ["sales of product income", "sales"],
    needed: true,
  },
  shipping_income: {
    subTypes: ["ShippingFreightDeliveryIncome", "OtherPrimaryIncome"],
    types: ["Income"],
    names: ["shipping"],
    needed: true,
  },
  other_income: {
    subTypes: ["OtherMiscellaneousIncome", "OtherPrimaryIncome"],
    types: ["Income", "Other Income"],
    names: ["other income"],
    needed: true,
  },
  returns_allowances: {
    subTypes: ["DiscountsRefundsGiven"],
    types: ["Income"],
    names: ["refund", "return", "discount"],
    needed: true,
  },
  sales_tax_collected: {
    subTypes: [],
    types: [],
    names: [],
    needed: false,
    skipReason:
      "The marketplace collected this and paid it to the state. It was never your money, so it does not belong in your books here or in QuickBooks.",
  },

  // ---- Cost of goods sold (Part III) --------------------------------------
  purchases: {
    subTypes: ["SuppliesMaterialsCogs", "CostOfLabourCos"],
    types: ["Cost of Goods Sold"],
    names: ["cost of goods sold", "purchases"],
    needed: true,
  },
  cogs_labor: {
    subTypes: ["CostOfLabourCos", "CostOfLabor"],
    types: ["Cost of Goods Sold"],
    names: ["labor", "labour"],
    needed: true,
  },
  cogs_materials: {
    subTypes: ["SuppliesMaterialsCogs"],
    types: ["Cost of Goods Sold"],
    names: ["materials", "supplies"],
    needed: true,
  },
  cogs_other: {
    subTypes: ["OtherCostsOfServiceCos", "ShippingFreightDeliveryCos"],
    types: ["Cost of Goods Sold"],
    names: ["other cost"],
    needed: true,
  },
  // The two inventory balances are a year-end journal, not a transaction. QBO
  // derives them from the inventory asset account it already keeps, so pushing
  // ours would double-count.
  inventory_beginning: {
    subTypes: [],
    types: [],
    names: [],
    needed: false,
    skipReason:
      "QuickBooks keeps its own inventory balance. Pushing ours as well would count the same stock twice.",
  },
  inventory_ending: {
    subTypes: [],
    types: [],
    names: [],
    needed: false,
    skipReason:
      "QuickBooks keeps its own inventory balance. Pushing ours as well would count the same stock twice.",
  },

  // ---- Operating expenses (Part II) ---------------------------------------
  advertising: {
    subTypes: ["AdvertisingPromotional"],
    types: ["Expense"],
    names: ["advertis", "marketing"],
    needed: true,
  },
  platform_fees: {
    subTypes: ["OtherMiscellaneousServiceCost", "CommissionsAndFees"],
    types: ["Expense"],
    names: ["commission", "fee"],
    needed: true,
  },
  depreciation: {
    subTypes: ["Depreciation"],
    types: ["Other Expense", "Expense"],
    names: ["depreciation"],
    needed: true,
  },
  insurance: {
    subTypes: ["Insurance"],
    types: ["Expense"],
    names: ["insurance"],
    needed: true,
  },
  interest_other: {
    subTypes: ["InterestPaid"],
    types: ["Expense", "Other Expense"],
    names: ["interest"],
    needed: true,
  },
  professional_services: {
    subTypes: ["LegalProfessionalFees"],
    types: ["Expense"],
    names: ["legal", "professional", "accounting"],
    needed: true,
  },
  office_expense: {
    subTypes: ["OfficeGeneralAdministrativeExpenses"],
    types: ["Expense"],
    names: ["office"],
    needed: true,
  },
  rent_equipment: {
    subTypes: ["EquipmentRental", "RentOrLeaseOfBuildings"],
    types: ["Expense"],
    names: ["equipment rental", "rent"],
    needed: true,
  },
  rent_property: {
    subTypes: ["RentOrLeaseOfBuildings"],
    types: ["Expense"],
    names: ["rent"],
    needed: true,
  },
  repairs: {
    subTypes: ["RepairMaintenance"],
    types: ["Expense"],
    names: ["repair", "maintenance"],
    needed: true,
  },
  supplies: {
    subTypes: ["SuppliesMaterials"],
    types: ["Expense"],
    names: ["supplies"],
    needed: true,
  },
  taxes_licenses: {
    subTypes: ["TaxesPaid"],
    types: ["Expense"],
    names: ["tax", "license", "licence"],
    needed: true,
  },
  sales_tax_remitted: {
    subTypes: ["TaxesPaid"],
    types: ["Expense"],
    names: ["sales tax"],
    needed: true,
  },
  travel: {
    subTypes: ["Travel"],
    types: ["Expense"],
    names: ["travel"],
    needed: true,
  },
  meals: {
    subTypes: ["TravelMeals", "EntertainmentMeals"],
    types: ["Expense"],
    names: ["meal"],
    needed: true,
  },
  utilities: {
    subTypes: ["Utilities"],
    types: ["Expense"],
    names: ["utilit"],
    needed: true,
  },
  shipping_postage: {
    subTypes: ["ShippingFreightDelivery", "OfficeGeneralAdministrativeExpenses"],
    types: ["Expense"],
    names: ["shipping", "postage", "freight"],
    needed: true,
  },
  software_subscriptions: {
    subTypes: ["OfficeGeneralAdministrativeExpenses", "DuesSubscriptions"],
    types: ["Expense"],
    names: ["software", "subscription", "dues"],
    needed: true,
  },
  // Mileage and the home office are computed by a formula on the return, not
  // booked as a transaction. Pushing them as expenses would deduct them twice
  // -- once in QBO and once when the accountant applies the standard rate.
  vehicle_mileage: {
    subTypes: [],
    types: [],
    names: [],
    needed: false,
    skipReason:
      "The standard mileage rate is worked out on the return, not booked as a bill. Pushing it would deduct the same miles twice.",
  },
  home_office: {
    subTypes: [],
    types: [],
    names: [],
    needed: false,
    skipReason:
      "The simplified home office is worked out on the return. Your actual rent and utilities already push as themselves.",
  },

  // ---- Neither income nor expense -----------------------------------------
  cash_payout: {
    subTypes: ["Checking", "Savings"],
    types: ["Bank"],
    names: ["checking", "bank"],
    needed: true,
  },
  uncategorised: {
    subTypes: [],
    types: [],
    names: [],
    needed: false,
    skipReason:
      "Nothing sorted here reaches your return, so nothing should reach QuickBooks either. Give each one a category and it will push under that.",
  },
};

const norm = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();
const isUsable = (a: QboAccount) => a.Active !== false;

/**
 * Deterministic choice among equally good candidates. QBO returns accounts in
 * whatever order its query felt like, and a proposal that depends on that order
 * is a proposal that changes under the seller between one screen and the next.
 */
function pick(candidates: QboAccount[]): QboAccount | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => norm(a.Name).localeCompare(norm(b.Name)) || a.Id.localeCompare(b.Id),
  )[0]!;
}

/**
 * Propose a QBO account for every GradeThread account, from the company's own
 * chart. Deterministic and order-independent: two sellers with the same chart
 * get the same proposal.
 */
export function proposeMapping(chart: QboAccount[]): MappingProposal[] {
  const active = chart.filter(isUsable);

  return SYSTEM_ACCOUNTS.map((acct): MappingProposal => {
    const target = TARGETS[acct.code];
    if (!target) {
      return {
        code: acct.code,
        qboId: null,
        qboName: null,
        basis: "none",
        note: "This account is new and has no proposed match yet. Pick one.",
      };
    }
    if (!target.needed) {
      return {
        code: acct.code,
        qboId: null,
        qboName: null,
        basis: "not_needed",
        note: target.skipReason ?? null,
      };
    }

    // Only ever consider accounts on the right side of the books. Without this
    // the name stage matches "Postage" against "Shipping Income" -- a revenue
    // account for an expense -- and validateMapping then rejects the proposal
    // this same function just made. The side rule belongs before the guessing,
    // not after it.
    const usable = active.filter((a) => wrongSide(acct, a) === null);

    for (const sub of target.subTypes) {
      const hits = usable.filter((a) => norm(a.AccountSubType) === norm(sub));
      const hit = pick(hits);
      if (hit) {
        return {
          code: acct.code,
          qboId: hit.Id,
          qboName: hit.FullyQualifiedName ?? hit.Name,
          basis: "subtype",
          note:
            hits.length > 1
              ? `You have ${hits.length} accounts of this kind. We took "${hit.Name}".`
              : null,
        };
      }
    }
    for (const name of target.names) {
      const hits = usable.filter((a) => norm(a.Name).includes(norm(name)));
      const hit = pick(hits);
      if (hit) {
        return {
          code: acct.code,
          qboId: hit.Id,
          qboName: hit.FullyQualifiedName ?? hit.Name,
          basis: "name",
          note: "Matched on the name alone, which is a weak guess. Check it.",
        };
      }
    }
    // Type is the LAST resort and only when it is unambiguous. A chart with
    // eleven Expense accounts cannot tell travel from utilities, and proposing
    // whichever one came back first is how a seller's meals land in insurance.
    // Proposing nothing is the honest answer, and the picker is right there.
    for (const type of target.types) {
      const hits = usable.filter((a) => norm(a.AccountType) === norm(type));
      if (hits.length === 1 && hits[0]) {
        return {
          code: acct.code,
          qboId: hits[0].Id,
          qboName: hits[0].FullyQualifiedName ?? hits[0].Name,
          basis: "type",
          note: "The only account of this type in your file. Check it before you sync.",
        };
      }
    }
    return {
      code: acct.code,
      qboId: null,
      qboName: null,
      basis: "none",
      note: "Nothing in your QuickBooks file looks like this. Pick an account or make one.",
    };
  });
}

/**
 * AC3 — validate the seller's choices against the LIVE chart, not against what
 * we proposed. An id can go stale between the mapping screen and the sync: an
 * account gets deactivated, merged, or deleted in QuickBooks and the id we hold
 * points at nothing.
 */
export function validateMapping(
  choice: MappingChoice,
  chart: QboAccount[],
): MappingProblem[] {
  const byId = new Map(chart.map((a) => [a.Id, a]));
  const problems: MappingProblem[] = [];

  for (const [code, qboId] of Object.entries(choice)) {
    if (!qboId) continue;
    const acct = SYSTEM_ACCOUNTS.find((a) => a.code === code);
    if (!acct) continue;

    const live = byId.get(qboId);
    if (!live) {
      problems.push({
        code,
        message: `The QuickBooks account for "${acct.name}" no longer exists. Pick another one.`,
        blocksOnlyThisAccount: true,
      });
      continue;
    }
    if (live.Active === false) {
      problems.push({
        code,
        message: `"${live.Name}" is switched off in QuickBooks, so nothing can post to it.`,
        blocksOnlyThisAccount: true,
      });
      continue;
    }
    const wrong = wrongSide(acct, live);
    if (wrong) {
      problems.push({ code, message: wrong, blocksOnlyThisAccount: true });
    }
  }
  return problems;
}

/**
 * The one validation worth doing beyond existence: income into an expense
 * account, or the reverse. It is the mistake that looks fine on the mapping
 * screen and shows up as a negative profit in March.
 */
function wrongSide(acct: LedgerAccount, live: QboAccount): string | null {
  const cls = norm(live.Classification);
  if (!cls) return null;

  if (acct.flow === "income" && cls !== "revenue") {
    return `"${acct.name}" is money coming in, but "${live.Name}" is a ${live.Classification} account in QuickBooks. Your profit would come out wrong.`;
  }
  if (
    (acct.flow === "expense" || acct.flow === "cogs") &&
    cls !== "expense" &&
    cls !== "cost of goods sold"
  ) {
    return `"${acct.name}" is money going out, but "${live.Name}" is a ${live.Classification} account in QuickBooks. Your profit would come out wrong.`;
  }
  if (acct.flow === "asset" && cls !== "asset") {
    return `"${acct.name}" is a bank deposit, so it needs a bank account. "${live.Name}" is a ${live.Classification} account.`;
  }
  return null;
}

/**
 * AC4 — which accounts block their OWN push, given what the period actually
 * used. An account with no activity does not need a mapping, and demanding one
 * would stop a seller who has never paid for advertising from syncing at all.
 */
export function blockedAccounts(
  choice: MappingChoice,
  usedCodes: readonly string[],
): MappingProblem[] {
  const out: MappingProblem[] = [];
  for (const code of usedCodes) {
    const target = TARGETS[code];
    if (target && !target.needed) continue;
    if (choice[code]) continue;
    const acct = SYSTEM_ACCOUNTS.find((a) => a.code === code);
    if (!acct) continue;
    out.push({
      code,
      message: `"${acct.name}" has activity but no QuickBooks account. Everything else still syncs; this one waits.`,
      blocksOnlyThisAccount: true,
    });
  }
  return out;
}

/** The accounts that never need a mapping, for the UI to grey out. */
export function accountsNotNeeded(): { code: string; reason: string }[] {
  return Object.entries(TARGETS)
    .filter(([, t]) => !t.needed)
    .map(([code, t]) => ({ code, reason: t.skipReason ?? "" }));
}

/** Turn a proposal list into the choice shape the seller edits. */
export function proposalToChoice(proposals: MappingProposal[]): MappingChoice {
  const out: MappingChoice = {};
  for (const p of proposals) out[p.code] = p.qboId;
  return out;
}
