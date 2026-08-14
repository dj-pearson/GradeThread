import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2514. /pricing showed eleven prices — three per-grade tiers, four credit
// packs, four FlipDesk plans — and not one of them carried an action. The only
// way to buy was the "Get Started" button in the shared marketing header, which
// says nothing about the plan the visitor had just decided on.
//
// This guards the property rather than the markup: every tile that renders a
// price must also render a link that leads somewhere a purchase can happen, and
// the destinations must be ones the app actually honours.

const PRICING = "src/pages/marketing/pricing.tsx";
const SUBMIT = "src/pages/new-submission.tsx";
const BILLING = "src/pages/billing.tsx";

const pricing = readFileSync(resolve(process.cwd(), PRICING), "utf8");

describe("every price on /pricing carries the action that buys it (US-2514)", () => {
  it("the three purchasable tile groups each render a CTA", () => {
    // Grade tiers → the submission flow, carrying the chosen tier.
    expect(pricing).toMatch(/\$\{SUBMIT_PATH\}\?tier=\$\{tier\.key\}/);
    // Credit packs → billing, opening the pack dialog.
    expect(pricing).toMatch(/\$\{BILLING_PATH\}&buy=credits/);
    // Plans → billing, opening the picker on that plan.
    expect(pricing).toMatch(/\$\{BILLING_PATH\}&upgrade=\$\{key\}/);
  });

  it("the destinations honour the parameters the CTAs send", () => {
    // A CTA that passes a parameter the destination ignores is a CTA that
    // silently does not preselect anything — which is the defect wearing a
    // button. Assert the receiving side reads each one.
    const submit = readFileSync(resolve(process.cwd(), SUBMIT), "utf8");
    expect(
      /searchParams\.get\("tier"\)/.test(submit),
      "new-submission.tsx must read ?tier= or the grade-tier CTAs preselect nothing",
    ).toBe(true);

    const billing = readFileSync(resolve(process.cwd(), BILLING), "utf8");
    expect(
      /searchParams\.get\("buy"\)/.test(billing),
      "billing.tsx must read ?buy= or the credit-pack CTAs land on a page with no dialog open",
    ).toBe(true);
    expect(
      /searchParams\.get\("upgrade"\)/.test(billing),
      "billing.tsx must read ?upgrade= (US-940) or the plan CTAs preselect nothing",
    ).toBe(true);
  });

  it("billing CTAs point at the Account hub, not the retired bare path", () => {
    // US-2511 moved billing into the hub. A `?tab=billing` path means the extra
    // parameter has to be appended with `&`, which is easy to get wrong.
    expect(pricing).toContain('const BILLING_PATH = "/dashboard/account?tab=billing"');
    expect(pricing).not.toMatch(/to="\/dashboard\/billing/);
  });

  it("annual pricing is reachable without signing up", () => {
    expect(pricing).toMatch(/priceYearlyCents/);
    expect(pricing).toMatch(/aria-label="Billing interval"/);
    // And the saving is stated rather than left for the visitor to compute.
    expect(pricing).toMatch(/yearlySavingPct/);
  });
});
