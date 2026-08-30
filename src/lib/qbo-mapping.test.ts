import { describe, it, expect } from "vitest";
import {
  proposeMapping,
  validateMapping,
  blockedAccounts,
  accountsNotNeeded,
  proposalToChoice,
  type QboAccount,
} from "./qbo-mapping";
import { SYSTEM_ACCOUNTS } from "./chart-of-accounts";

// US-2997.

function acct(over: Partial<QboAccount> & { Id: string; Name: string }): QboAccount {
  return { Active: true, ...over };
}

/** A chart shaped like a real QBO sole-proprietor file. */
const CHART: QboAccount[] = [
  acct({
    Id: "1",
    Name: "Sales of Product Income",
    AccountType: "Income",
    AccountSubType: "SalesOfProductIncome",
    Classification: "Revenue",
  }),
  acct({
    Id: "2",
    Name: "Shipping Income",
    AccountType: "Income",
    AccountSubType: "ShippingFreightDeliveryIncome",
    Classification: "Revenue",
  }),
  acct({
    Id: "3",
    Name: "Cost of Goods Sold",
    AccountType: "Cost of Goods Sold",
    AccountSubType: "SuppliesMaterialsCogs",
    Classification: "Cost of Goods Sold",
  }),
  acct({
    Id: "4",
    Name: "Advertising",
    AccountType: "Expense",
    AccountSubType: "AdvertisingPromotional",
    Classification: "Expense",
  }),
  acct({
    Id: "5",
    Name: "Checking",
    AccountType: "Bank",
    AccountSubType: "Checking",
    Classification: "Asset",
  }),
  acct({
    Id: "6",
    Name: "Insurance",
    AccountType: "Expense",
    AccountSubType: "Insurance",
    Classification: "Expense",
  }),
];

describe("proposeMapping", () => {
  it("covers every account in the chart of accounts, with no silent gaps", () => {
    const p = proposeMapping(CHART);
    expect(p.map((x) => x.code).sort()).toEqual(
      SYSTEM_ACCOUNTS.map((a) => a.code).sort(),
    );
  });

  it("prefers the exact subtype over a type or a name", () => {
    const p = proposeMapping(CHART).find((x) => x.code === "sales_revenue");
    expect(p?.qboId).toBe("1");
    expect(p?.basis).toBe("subtype");
    // A confident match carries no caveat. Caveats on everything are ignored.
    expect(p?.note).toBeNull();
  });

  it("labels a weaker match as weaker, rather than hiding it", () => {
    // No SuppliesMaterials expense subtype in this file, so "supplies" falls
    // back. The seller has to be told which guesses to check.
    const p = proposeMapping(CHART).find((x) => x.code === "supplies");
    expect(p?.basis).not.toBe("subtype");
    if (p?.qboId) expect(p.note).toMatch(/check/i);
  });

  it("says an account is not needed rather than leaving it blank", () => {
    // A blank row reads as a bug the seller has to fix. "Not needed, here is
    // why" reads as an answer.
    const p = proposeMapping(CHART).find((x) => x.code === "vehicle_mileage");
    expect(p?.basis).toBe("not_needed");
    expect(p?.note).toMatch(/twice/i);
  });

  it("refuses to push the two things that would be deducted twice", () => {
    const notNeeded = accountsNotNeeded().map((n) => n.code);
    expect(notNeeded).toContain("vehicle_mileage");
    expect(notNeeded).toContain("home_office");
    // And the two inventory balances, which QBO keeps itself.
    expect(notNeeded).toContain("inventory_beginning");
    expect(notNeeded).toContain("inventory_ending");
    // Every one of them explains itself.
    for (const n of accountsNotNeeded()) expect(n.reason.length).toBeGreaterThan(20);
  });

  it("never proposes a deactivated account", () => {
    const dead = CHART.map((a) =>
      a.Id === "1" ? { ...a, Active: false } : a,
    );
    const p = proposeMapping(dead).find((x) => x.code === "sales_revenue");
    expect(p?.qboId).not.toBe("1");
  });

  it("returns nothing rather than something wrong when the file is empty", () => {
    // A brand-new QBO file. Guessing here is how a sale lands in Owner's Equity.
    const p = proposeMapping([]);
    const needed = p.filter((x) => x.basis !== "not_needed");
    expect(needed.every((x) => x.qboId === null)).toBe(true);
    expect(needed[0]?.note).toMatch(/pick an account/i);
  });

  it("is order-independent: the same chart shuffled gives the same answer", () => {
    const a = proposalToChoice(proposeMapping(CHART));
    const b = proposalToChoice(proposeMapping([...CHART].reverse()));
    expect(a).toEqual(b);
  });
});

describe("validateMapping", () => {
  it("passes a mapping that still points at live accounts", () => {
    expect(validateMapping(proposalToChoice(proposeMapping(CHART)), CHART)).toEqual([]);
  });

  it("never rejects what proposeMapping just proposed, on any chart", () => {
    // The invariant, and it was broken until the side filter went in: a name
    // match put postage into "Shipping Income" and validation then refused the
    // suggestion the same screen had made. A proposer and a validator that
    // disagree are two rules, and the seller has to work out which one is real.
    const charts = [CHART, [...CHART].reverse(), CHART.slice(0, 2), []];
    for (const c of charts) {
      expect(validateMapping(proposalToChoice(proposeMapping(c)), c)).toEqual([]);
    }
  });

  it("catches an account that was deleted in QuickBooks after mapping", () => {
    const choice = { sales_revenue: "999" };
    const p = validateMapping(choice, CHART);
    expect(p[0]?.message).toMatch(/no longer exists/i);
  });

  it("catches an account switched off after mapping", () => {
    const dead = CHART.map((a) => (a.Id === "4" ? { ...a, Active: false } : a));
    const p = validateMapping({ advertising: "4" }, dead);
    expect(p[0]?.message).toMatch(/switched off/i);
  });

  it("catches income pointed at an expense account", () => {
    // The mistake that looks fine on the screen and shows up as a negative
    // profit in March.
    const p = validateMapping({ sales_revenue: "4" }, CHART);
    expect(p[0]?.message).toMatch(/money coming in/i);
    expect(p[0]?.message).toMatch(/profit would come out wrong/i);
  });

  it("catches an expense pointed at an income account", () => {
    const p = validateMapping({ advertising: "1" }, CHART);
    expect(p[0]?.message).toMatch(/money going out/i);
  });

  it("insists a payout goes to a bank account", () => {
    const p = validateMapping({ cash_payout: "4" }, CHART);
    expect(p[0]?.message).toMatch(/bank account/i);
  });

  it("ignores an account the seller left unmapped", () => {
    // Unmapped is AC4's business, not a validation error. Reporting it twice
    // is how a screen ends up with two lists of the same problem.
    expect(validateMapping({ advertising: null }, CHART)).toEqual([]);
  });
});

describe("blockedAccounts", () => {
  it("blocks only the account with activity and no mapping", () => {
    const choice = { sales_revenue: "1" };
    const p = blockedAccounts(choice, ["sales_revenue", "insurance"]);
    expect(p.map((x) => x.code)).toEqual(["insurance"]);
    expect(p[0]?.blocksOnlyThisAccount).toBe(true);
    // AC4: it must say the rest still syncs, or a seller reads it as a stop.
    expect(p[0]?.message).toMatch(/everything else still syncs/i);
  });

  it("does not demand a mapping for an account with no activity", () => {
    // A seller who has never paid for advertising must not be stopped from
    // syncing by an empty advertising row.
    expect(blockedAccounts({}, [])).toEqual([]);
  });

  it("never blocks on an account that is not meant to push", () => {
    expect(blockedAccounts({}, ["vehicle_mileage", "home_office"])).toEqual([]);
  });
});
