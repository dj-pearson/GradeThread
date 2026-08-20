import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2016, the pay half. The finding this file protects is the one that shrank
// the story: `POST /api/grade/pay/:id` takes NO CARD. It charges the seller's
// included monthly grades, then their credit balance, and when neither covers
// it, it names the credit pack that would - a pack iOS already sells through
// StoreKit. So there is no Apple-commission decision to reopen and no browser
// hand-off mid-journey.
//
// What can drift are two pairs of lists nobody currently compares:
//   • the route's payment vocabulary ("included" / "credits") against the
//     branches the client switches on;
//   • the server's credit-pack SIZES against the App Store product ids.

const PRECEDENCE = "services/edge-functions/src/lib/grade-precedence.ts";
const PRICING = "services/edge-functions/src/lib/grade-pricing.ts";
const ROUTE = "services/edge-functions/src/routes/grade.ts";
const SWIFT = "ios/GradeThread/Grading/PhotoGradePayment.swift";
const IAP = "ios/GradeThread/Billing/IAPProduct.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\/\/\/.*$/gm, "");
}

describe("paying for a grade takes no card (US-2016)", () => {
  it("the route charges included grades, then credits", () => {
    // The premise. If this ever grew a Stripe branch, the iOS flow would need a
    // decision it currently does not.
    const src = code(PRECEDENCE);
    expect(src).toContain('method: "included"');
    expect(src).toContain('method: "credits"');
  });

  it("the client branches on the SAME two method values", () => {
    // Keyed on `method`, not on whichever count arrived: both counts are
    // optional in the wire shape, so "whichever field is present" picks the
    // wrong branch the day the route adds one.
    const swift = code(SWIFT);
    expect(swift).toContain('case "included"');
    expect(swift).toContain("newIncludedUsed");
    expect(swift).toContain("newBalance");
  });

  it("an unpaid answer is a state, not an error", () => {
    // It is the normal path for anyone out of included grades. Treating it as a
    // failure shows a red banner to a customer about to buy something.
    const swift = code(SWIFT);
    expect(swift).toContain("case needsCredits(offer: PackOffer?)");
    expect(swift).toContain("checkoutRequired");
  });

  it("the route really can answer with no pack at all", () => {
    // suggestPackFrom returns null when nothing fits, so the optional in the
    // Swift is the honest shape rather than defensive noise.
    expect(code(PRECEDENCE)).toContain("suggestedPack: PackOffer | null");
  });
});

describe("the credit packs and the App Store products agree (US-2016)", () => {
  /** The server's compiled fallback pack sizes. */
  function serverPackCredits(): number[] {
    const src = read(PRICING);
    const block = /CREDIT_PACKS: readonly CreditPack\[\] = \[([\s\S]*?)\];/.exec(src);
    expect(block, "CREDIT_PACKS moved in grade-pricing.ts").toBeTruthy();
    return [...block![1]!.matchAll(/credits:\s*(\d+)/g)].map((m) => Number(m[1]));
  }

  /** The consumable product ids the app ships. */
  function storeKitCredits(): number[] {
    const src = read(IAP);
    return [...src.matchAll(/com\.gradethread\.credits\.(\d+)/g)].map((m) =>
      Number(m[1]),
    );
  }

  it("every pack the route can suggest is one the store sells", () => {
    // A suggested size the store does not carry is a purchase button that
    // cannot resolve a product - it fails at the till, after the user decided
    // to pay.
    const missing = serverPackCredits().filter(
      (c) => !storeKitCredits().includes(c),
    );
    expect(
      missing,
      "these credit packs exist server-side and have no com.gradethread.credits.N " +
        "product in IAPProduct.swift",
    ).toEqual([]);
  });

  it("the Swift maps a pack size to that product id", () => {
    const swift = code(SWIFT);
    expect(swift).toContain("com.gradethread.credits.");
    // Unknown size -> nil, so the UI can fall back to the paywall instead of
    // showing a button that cannot buy anything.
    expect(swift).toContain("guard known.contains(credits) else { return nil }");
  });

  it("states plainly what it cannot cover", () => {
    // CREDIT_PACKS is overridable from admin via pricing_config (US-885), so a
    // LIVE pack list can still diverge from the store. A guard that implied
    // otherwise would be worse than this comment.
    expect(read(SWIFT)).toContain("overridable from admin via pricing_config");
  });
});

describe("the route is the one being modelled (US-2016)", () => {
  it("pay/:id answers with these exact keys", () => {
    const route = code(ROUTE);
    expect(route).toContain('gradeRoutes.post("/pay/:id"');
    expect(route).toContain("checkoutRequired: true");
    expect(route).toContain("suggestedPack");
  });
});
