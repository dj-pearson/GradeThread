// US-9127 AC1: /pricing must name the Claude connector on the tiers that get it
// and STATE the monthly cap, rather than leaving a prospect to find it on
// /developers.
//
// The failure this guards is the US-2123 shape: an advertised number and a
// granted number drifting apart. `connectorActionsPerMonth` is what
// connector-allowance.ts counts against and `gateFlags.connectorAccess` is what
// the plan gate checks, so the assertions below compare the RENDERED page to
// those two fields rather than to a number typed into a test. Change the
// allowance in constants.ts and this test keeps passing; type the allowance
// into the copy and it starts failing the first time the two disagree.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PricingPage } from "@/pages/marketing/pricing";
import { FLIPDESK_PLANS } from "@/lib/constants";
import { PRICING_FAQS } from "@/pages/marketing/marketing-jsonld";
import type { FlipdeskPlan as FlipdeskPlanKey } from "@/types/database";

function render(): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PricingPage />
        </MemoryRouter>
      </QueryClientProvider>
    </HelmetProvider>,
  );
}

const PLANS = Object.keys(FLIPDESK_PLANS) as FlipdeskPlanKey[];

describe("pricing page: the Claude connector (US-9127 AC1)", () => {
  it("names the connector, on the plan tiles rather than only in a footnote", () => {
    const html = render();
    expect(html).toMatch(/Claude connector/);
  });

  it("states each entitled plan's cap, read from the field the edge enforces", () => {
    const html = render();
    const entitled = PLANS.filter((k) => FLIPDESK_PLANS[k].gateFlags.connectorAccess);

    // A registry with nothing in it would pass every loop below vacuously.
    expect(entitled.length).toBeGreaterThan(0);

    for (const key of entitled) {
      const cap = FLIPDESK_PLANS[key].connectorActionsPerMonth;
      expect(
        cap,
        `${key} has connectorAccess but no allowance to advertise`,
      ).toBeGreaterThan(0);
      expect(
        html,
        `/pricing does not state ${key}'s connector allowance (${cap})`,
      ).toContain(`${cap.toLocaleString()} actions`);
    }
  });

  it("does not advertise a connector allowance to a plan that has no access", () => {
    // The inverse half. A tile that shows the line for every plan reads as
    // "included" to a Starter shopper, who is then refused by the plan gate.
    for (const key of PLANS) {
      const plan = FLIPDESK_PLANS[key];
      if (plan.gateFlags.connectorAccess) continue;
      expect(
        plan.connectorActionsPerMonth,
        `${key} has no connectorAccess, so its allowance must be 0`,
      ).toBe(0);
    }
    // One allowance line per entitled plan, and no more. Counted rather than
    // string-matched: "0 actions a month" is a SUBSTRING of "2,000 actions a
    // month", so the obvious negative assertion here passes for the wrong
    // reason and fails for the wrong reason too. The anchor is the tile's own
    // markup, because the pricing FAQ answer further down the page states the
    // same allowances in prose and would otherwise be counted as a tile.
    const entitled = PLANS.filter((k) => FLIPDESK_PLANS[k].gateFlags.connectorAccess);
    const tileLines = render().match(/Claude connector<\/span>\s*<span[^>]*>[\d,]+ actions a month/g) ?? [];
    expect(tileLines.length).toBe(entitled.length);
  });

  it("reads the numbers instead of typing them", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/pages/marketing/pricing.tsx"),
      "utf8",
    );
    expect(src).toContain("plan.connectorActionsPerMonth");
    expect(src).toContain("plan.gateFlags.connectorAccess");

    // The rendered assertions above would pass just as happily against a
    // hand-typed "500", so prove the binding: move the source of truth and the
    // page has to move with it. A source scan for the literal cannot do this —
    // `amber-500` is a Tailwind class, and 500 is also an allowance.
    const pro = FLIPDESK_PLANS.pro as { connectorActionsPerMonth: number };
    const real = pro.connectorActionsPerMonth;
    try {
      pro.connectorActionsPerMonth = 4321;
      const html = render();
      expect(html).toContain("4,321 actions");
      expect(html).not.toContain(`${real.toLocaleString()} actions a month`);
    } finally {
      pro.connectorActionsPerMonth = real;
    }
  });

  it("says what the count covers, because 'actions' alone is not a promise", () => {
    const html = render();
    // Reads being free is the fact that makes the number legible. Without it a
    // shopper prices 500 as 500 conversations.
    expect(html).toMatch(/Reading costs nothing/i);
    expect(html).toMatch(/sandbox/i);
  });

  it("the pricing FAQ answer carries the live allowances", () => {
    const faq = PRICING_FAQS.find((f) => /Claude connector/i.test(f.q));
    expect(faq, "PRICING_FAQS has no connector entry").toBeDefined();
    for (const key of ["pro", "business"] as const) {
      const cap = FLIPDESK_PLANS[key].connectorActionsPerMonth;
      expect(faq!.a).toContain(cap.toLocaleString());
    }
  });
});
