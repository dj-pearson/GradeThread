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

  it("the landing page renders pack prices exactly, matching /pricing", () => {
    // Source guard: the two pages must not disagree about a price. Pinned at
    // the source because both render from the same constant — a behavioural
    // test would need both pages mounted to compare a string they both derive.
    const landing = readFileSync(resolve(process.cwd(), "src/pages/landing.tsx"), "utf8");
    const packBlock = landing.slice(
      landing.indexOf("pack.priceCents"),
      landing.indexOf("pack.priceCents") + 120,
    );
    expect(
      packBlock,
      "landing renders a credit-pack price with toFixed(0) — that shows $25 for " +
        "a $24.99 pack while /pricing shows $24.99",
    ).not.toContain("toFixed(0)");
    expect(packBlock).toContain("toFixed(2)");
  });
});
