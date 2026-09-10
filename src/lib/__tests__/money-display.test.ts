// US-2075 — a price shown to a buyer must be the price they are charged.
//
// This repo has 16 independent `dollars()` helpers and they disagree: most use
// toFixed(2), two use toFixed(0), one omits the "$". That divergence is only
// SOMETIMES a bug, which is what makes it hard to see:
//
//   • FLIPDESK_PLANS are whole dollars (2900/5900/9900 and 29000/59000/99000),
//     so toFixed(0) on a plan card loses nothing and reads better.
//   • CREDIT_PACKS and GRADETHREAD_TIERS ALL carry cents (2499, 5999, 299 …),
//     so rounding those is money the display invents.
//
// The live instance: the landing page rendered a $24.99 pack as "$25" while
// /pricing rendered $24.99 — the same pack at two prices on one site, on the
// page headlined "transparent pricing".
//
// This test pins the RULE rather than the call sites, so it keeps holding as
// prices change and new surfaces are added.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CREDIT_PACKS, GRADETHREAD_TIERS, FLIPDESK_PLANS } from "@/lib/constants";

describe("money display", () => {
  it("credit packs and grade tiers carry cents, so they must never be rounded", () => {
    // The premise of the rule. If pricing ever moves to whole dollars this
    // fails LOUDLY rather than leaving a stale rule in place.
    const packCents = Object.values(CREDIT_PACKS).map((p) => p.priceCents);
    const tierCents = Object.values(GRADETHREAD_TIERS).map((t) => t.priceCents);
    expect(packCents.length).toBeGreaterThan(0);
    expect(
      packCents.some((c) => c % 100 !== 0),
      "credit packs no longer carry cents — re-check whether the no-rounding rule still applies",
    ).toBe(true);
    expect(tierCents.some((c) => c % 100 !== 0)).toBe(true);
  });

  it("plan prices ARE whole dollars, so rounding them is legitimate", () => {
    // Recorded so nobody "fixes" the plan cards to two decimals thinking it
    // matches this rule. $29.00/mo is worse copy than $29/mo, and loses nothing.
    for (const plan of Object.values(FLIPDESK_PLANS)) {
      expect(plan.priceMonthlyCents % 100).toBe(0);
      expect(plan.priceYearlyCents % 100).toBe(0);
    }
  });

  it("the landing page and /pricing render pack prices through the SAME formatter", () => {
    // Source guard: the two pages must not disagree about a price.
    //
    // The original bug was landing formatting a pack with a local toFixed(0),
    // showing $25 for a $24.99 pack while /pricing showed $24.99. That was fixed
    // by pinning landing to toFixed(2) — which held, but left two independent
    // formatters one edit apart from disagreeing again.
    //
    // US-3299 removed the second formatter instead. Both pages now render packs
    // through SalePrice, whose dollarsExact prints cents only when there are
    // cents. That is now load-bearing rather than cosmetic: a live discount can
    // turn ANY whole-dollar price into a cents-bearing one, so "which constants
    // carry cents" is no longer a property a formatter can be chosen from.
    const files = ["src/pages/landing.tsx", "src/pages/marketing/pricing.tsx"];
    for (const rel of files) {
      const text = readFileSync(resolve(process.cwd(), rel), "utf8");
      const at = text.indexOf("kind: \"credit_pack\"");
      expect(at, `${rel} no longer renders a credit-pack price through SalePrice`)
        .toBeGreaterThan(-1);
      // The 400 characters around the target cover the whole <SalePrice> call.
      const block = text.slice(Math.max(0, at - 400), at + 200);
      expect(
        block,
        `${rel} rounds a credit-pack price to whole dollars — that shows $25 for ` +
          "a $24.99 pack, and hides the cents a discount creates",
      ).not.toContain("toFixed(0)");
      expect(block, `${rel} should format the pack price via SalePrice`)
        .toContain("SalePrice");
    }
  });

  it("the whole-dollar billing components stay free of cents-bearing money", () => {
    // The other two toFixed(0) formatters live in the FlipDesk plan cards. They
    // are safe ONLY because every value reaching them comes from FLIPDESK_PLANS,
    // which the test above pins to whole dollars. Nothing structurally stops a
    // later edit from rendering a credit pack or a grading tier through the same
    // helper — and that is precisely the bug that shipped on landing ($25 for a
    // $24.99 pack). Keeping the cents-bearing constants OUT of these two files
    // makes the safety a property of the file rather than of reviewer attention.
    const wholeDollarFiles = [
      "src/components/billing/flipdesk-plan-comparison.tsx",
      "src/components/billing/flipdesk-plan-picker-dialog.tsx",
    ];
    for (const rel of wholeDollarFiles) {
      const text = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(
        text,
        `${rel} rounds money to whole dollars, so importing a constant that ` +
          "carries cents (CREDIT_PACKS / GRADETHREAD_TIERS) risks displaying a " +
          "price the customer is not charged. Format those with toFixed(2).",
      ).not.toMatch(/\b(CREDIT_PACKS|GRADETHREAD_TIERS)\b/);
    }
  });
});
