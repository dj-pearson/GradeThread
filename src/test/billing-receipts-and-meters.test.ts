import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2524. Billing rendered the same usage caps twice — once inside the
// subscription card and once again lower down under a heading that literally
// read "Same data, compact view" — and every path to a receipt was a link out
// to the Stripe portal. The trial banner said "Pro free trial active" whatever
// plan was on trial, and the store-managed banner described where to look
// instead of linking there.

const PAGE = "src/pages/billing.tsx";
const METER = "src/components/billing/usage-meter.tsx";
const INVOICES = "src/components/billing/invoice-history.tsx";
const ROUTE = "services/edge-functions/src/routes/payments.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("one set of usage meters (US-2524)", () => {
  it("the page renders the shared meters exactly once", () => {
    const src = read(PAGE);
    const uses = src.match(/<UsageMeters\b/g) ?? [];
    expect(uses.length).toBe(1);
    expect(src).not.toContain("Same data, compact view");
    expect(src).not.toContain("Usage at a glance");
  });

  it("the shared component carries every cap the page used to add itself", () => {
    const meter = read(METER);
    for (const label of [
      "Active listings",
      "AI actions",
      "Included grades",
      "Grade credits",
      "Marketplaces connected",
    ]) {
      expect(meter, `the shared meters dropped ${label}`).toContain(label);
    }
    // The marketplaces meter is meaningless on an unlimited plan.
    expect(meter).toMatch(/label="Marketplaces connected"[\s\S]*?hideWhenUnlimited/);
  });
});

describe("receipts are in the app (US-2524)", () => {
  it("the page renders an invoice history", () => {
    expect(read(PAGE)).toContain("<InvoiceHistory />");
  });

  it("the list is read from the caller's own Stripe customer", () => {
    const route = read(ROUTE);
    expect(route).toMatch(/paymentRoutes\.get\("\/invoices"/);
    // The customer id comes from the caller's row, never the request (US-268).
    expect(route).toMatch(/\.eq\("id", userId\)/);
    expect(route).toMatch(/stripe\.invoices\.list\(\{ customer: customerId/);
  });

  it("a customer who never paid gets an empty list, not an error", () => {
    expect(read(ROUTE)).toMatch(/if \(!customerId\) return c\.json\(\{ invoices: \[\] \}\)/);
  });

  it("the documents of record stay Stripe's", () => {
    const src = read(INVOICES);
    // We list the charges; we never re-render an invoice, because a receipt we
    // generated ourselves is not the one the tax authority sees.
    expect(src).toContain("hosted_invoice_url");
    expect(src).toContain("invoice_pdf");
    expect(src).toContain('rel="noopener noreferrer"');
  });

  it("a failed load says so instead of showing an empty history", () => {
    const src = read(INVOICES);
    expect(src).toContain("<ErrorState");
    expect(src).toMatch(/onRetry=\{\(\) => refetch\(\)\}/);
  });
});

describe("the banners tell the truth (US-2524)", () => {
  it("the trial banner names the plan actually on trial", () => {
    const src = read(PAGE);
    expect(src).not.toContain("Pro free trial active");
    expect(src).toMatch(/\{planLabel\(subscription\.plan\)\} free trial active/);
    // And its CTA opens the picker on that plan, not hardcoded "pro".
    expect(src).not.toMatch(/openPlanPicker\("pro"\)/);
  });

  it("the store-managed banner links to the store's subscription settings", () => {
    const src = read(PAGE);
    expect(src).toContain("https://apps.apple.com/account/subscriptions");
    expect(src).toContain("https://play.google.com/store/account/subscriptions");
    expect(src).toMatch(/href=\{storeSubscriptionsUrl\}/);
    // The sentence that described where to look, and stopped there.
    expect(src).not.toContain("go to Settings → Subscription");
  });
});
