import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-3265. The last hand-off in the best connect flow FlipDesk has.
//
// The Business policies dialog used to answer an account with no policies by
// telling it to go and make them in eBay Seller Hub and come back. That
// sentence was shown mid-connect, to the seller least able to act on it, and
// every publish refused until they did. FlipDesk holds the token, opts the
// account into policy management and already creates the merchant location
// nobody else creates.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const PAGE = read("src/pages/flipdesk/marketplaces.tsx");
const HOOKS = read("src/hooks/use-ebay.ts");

describe("the empty-policies state (US-3265)", () => {
  it("no longer sends the seller to Seller Hub", () => {
    expect(PAGE).not.toMatch(/Set up shipping,\s*payment and returns in eBay Seller Hub/);
  });

  it("offers to create them instead", () => {
    expect(PAGE).toContain("Create these for me");
    expect(PAGE).toMatch(/createPolicies\.mutate\(/);
  });

  it("asks four things and nothing an eBay-literate seller would have to look up", () => {
    // Handling time, postage price, returns yes/no, and (when yes) the window
    // and who pays. No policy names, no category type, no marketplace id, no
    // payment method: those have defaults and are not the seller's decision.
    expect(PAGE).toContain("Days to post after a sale");
    expect(PAGE).toContain("What the buyer pays for postage");
    expect(PAGE).toContain("I accept returns");
    expect(PAGE).toContain("Buyer pays return postage");
    for (const jargon of [
      "categoryTypes",
      "marketplaceTypes",
      "ALL_EXCLUDING_MOTORS_VEHICLES",
      "immediatePay",
    ]) {
      expect(PAGE, `${jargon} is put to the seller`).not.toContain(jargon);
    }
  });

  it("sends whole cents and a bounded handling time", () => {
    // The input is dollars because that is what a seller thinks in; the wire is
    // cents because that is what the route validates.
    expect(PAGE).toMatch(/shipping_cost_cents: Math\.max\(/);
    expect(PAGE).toMatch(/Math\.min\(30, Math\.round\(Number\(handlingDays\)/);
  });
});

describe("the hook (US-3265)", () => {
  it("posts to the create route and surfaces eBay's own reason", () => {
    expect(HOOKS).toContain("useCreateEbayPolicies");
    expect(HOOKS).toContain("/api/flipdesk/ebay/policies/create");
    // json.detail carries eBay's message; without it every failure reads as the
    // same generic sentence.
    expect(HOOKS).toMatch(/json\.detail \|\| json\.error \|\| "Could not create your eBay policies\."/);
  });

  it("refreshes the policy list so the picker fills in", () => {
    const idx = HOOKS.indexOf("useCreateEbayPolicies");
    const body = HOOKS.slice(idx, idx + 2000);
    expect(body).toMatch(/invalidateQueries\(\{ queryKey: \["ebay_policies"\] \}\)/);
  });

  it("says something true when there was nothing to create", () => {
    const idx = HOOKS.indexOf("useCreateEbayPolicies");
    const body = HOOKS.slice(idx, idx + 2000);
    expect(body).toMatch(/data\.created\.length > 0/);
  });
});
