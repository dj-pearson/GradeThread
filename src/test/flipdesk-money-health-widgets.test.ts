import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_LAYOUTS,
  widgetById,
  widgetsForSurface,
  widgetWindowPhrase,
  type LayoutContext,
} from "@/lib/dashboard-widgets";
import { addableWidgets, normalize } from "@/lib/dashboard-layout";
import { overviewRangeDays } from "@/lib/overview-range";
import { summarizeDuePayouts } from "@/lib/consignor-payouts";
import type { ConsignorPayoutRow, ConsignorPayoutStatus } from "@/types/database";

// US-3078: the money and account-health widgets.
//
// The claim this file exists for is AC7, and it is the whole story: these six
// frames must be the cards that already exist, not new drawings of them. A
// widget that copied the payout list would pass every other test here and be
// exactly the defect the story was written to avoid, so the check is on the
// IMPORT: resolve each widget id to its module and require the named component
// in it, and require the source page to keep rendering the same one.

const registry = widgetsForSurface("flipdesk");

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * The six, and the component each one is not allowed to reimplement.
 *
 * `module` is the file the registry's dynamic import resolves to. Four of the
 * six are wrapper modules under widgets/, because each adds something the card
 * does not have: a summary line, a day-window conversion, three cards composed
 * into one frame, a tile over a hook. Two are the CARD ITSELF, loaded straight
 * the way grading.charts and flipdesk.community-insights are, because a wrapper
 * that only forwards would be a file to keep in step for no gain.
 *
 * `flipdesk.consignor-payouts` names a HOOK rather than a component because
 * there is no consignor-payout card to reuse: the Consignment page renders that
 * data inside a page-level panel. The rule it is held to is the same one -- the
 * widget goes through the existing read instead of writing its own query.
 */
const WRAPS: Record<
  string,
  { module: string; imports: string[]; page: string; wrapper: boolean }
> = {
  "flipdesk.payouts": {
    module: "src/components/dashboard/widgets/flipdesk-payouts.tsx",
    imports: ["EbayPayoutsCard", "useEbayPayouts"],
    page: "src/pages/flipdesk/reconciliation.tsx",
    wrapper: true,
  },
  "flipdesk.ad-spend": {
    module: "src/components/dashboard/widgets/flipdesk-ad-spend.tsx",
    imports: ["AdSpendCard"],
    page: "src/pages/finances.tsx",
    wrapper: true,
  },
  "flipdesk.equity": {
    module: "src/components/flipdesk/inventory-equity-card.tsx",
    imports: ["InventoryEquityCard"],
    page: "src/pages/flipdesk/analytics.tsx",
    wrapper: false,
  },
  "flipdesk.forecast": {
    module: "src/components/flipdesk/forecast-card.tsx",
    imports: ["ForecastCard"],
    page: "src/pages/flipdesk/scout.tsx",
    wrapper: false,
  },
  "flipdesk.marketplace-health": {
    module: "src/components/dashboard/widgets/flipdesk-marketplace-health.tsx",
    imports: [
      "MarketplaceConnectionSummary",
      "EbayAccountHealthCard",
      "useEbayConnectionIssue",
    ],
    page: "src/pages/flipdesk/marketplaces.tsx",
    wrapper: true,
  },
  "flipdesk.consignor-payouts": {
    module: "src/components/dashboard/widgets/flipdesk-consignor-payouts.tsx",
    imports: ["useConsignorPayouts"],
    page: "src/pages/flipdesk/consignment.tsx",
    wrapper: true,
  },
};

const IDS = Object.keys(WRAPS);
const WRAPPERS = IDS.filter((id) => WRAPS[id]!.wrapper);

describe("no card is drawn twice (US-3078 AC7)", () => {
  it("resolves every widget id to a module that names the existing component", () => {
    for (const [id, want] of Object.entries(WRAPS)) {
      const def = widgetById(id, registry);
      expect(def, `${id} is not registered`).toBeDefined();
      // The registry's own dynamic import has to point at that module, or the
      // file this test reads is not the file the board loads. The path in the
      // import survives Vite's transform of the arrow function.
      const path = want.module.replace(/^src\//, "").replace(/\.tsx$/, "");
      expect(String(def!.load), id).toContain(path);

      const src = read(want.module);
      for (const name of want.imports) {
        // A wrapper IMPORTS the name; a card loaded straight EXPORTS it.
        const declared = want.wrapper
          ? new RegExp(`import[\\s\\S]{0,200}\\b${name}\\b[\\s\\S]{0,200}from`)
          : new RegExp(`export function ${name}\\b`);
        expect(src, `${id} does not reuse ${name}`).toMatch(declared);
      }
    }
  });

  it("leaves every source page rendering the same component", () => {
    for (const [id, want] of Object.entries(WRAPS)) {
      const page = read(want.page);
      const name = want.imports[0]!;
      expect(page, `${want.page} stopped rendering ${name} for ${id}`).toContain(
        name,
      );
    }
  });

  it("keeps the wrappers thin enough that nothing was copied into them", () => {
    // A widget that reimplemented a card would be hundreds of lines. The real
    // guard is the import above; this is the cheap tripwire that catches markup
    // being pasted in beside the import rather than instead of it. Only the
    // wrappers: the two cards loaded straight are as long as they have always
    // been, and this story did not touch their length.
    for (const id of WRAPPERS) {
      const file = WRAPS[id]!.module;
      const lines = read(file).split("\n").length;
      expect(lines, `${file} is ${lines} lines`).toBeLessThan(100);
    }
  });

  it("writes no query of its own: every wrapper reads through a hook or card", () => {
    for (const id of WRAPPERS) {
      const src = read(WRAPS[id]!.module);
      expect(src, `${id} reads supabase directly`).not.toContain('@/lib/supabase"');
      expect(src, `${id} calls the edge directly`).not.toContain(
        '@/lib/edge-fetch"',
      );
      expect(src, `${id} opens its own query`).not.toContain("useQuery(");
    }
  });
});

describe("the six are registered and none is on the default board", () => {
  it("files every one under 'data', for FlipDesk personas only", () => {
    for (const id of IDS) {
      const def = widgetById(id, registry)!;
      expect(def.category, id).toBe("data");
      // A buyer has no FlipDesk surface: one of these on that board would query
      // rows the account cannot read and render an error frame forever.
      expect(def.personas, id).not.toContain("buyer");
      expect(def.sizes, id).toContain(def.defaultSize);
    }
  });

  it("allows exactly the sizes this story fixes", () => {
    const expected: Record<string, { sizes: string[]; def: string }> = {
      "flipdesk.payouts": { sizes: ["md", "lg"], def: "lg" },
      "flipdesk.ad-spend": { sizes: ["md", "lg"], def: "md" },
      "flipdesk.equity": { sizes: ["md", "lg"], def: "md" },
      "flipdesk.forecast": { sizes: ["md", "lg"], def: "lg" },
      "flipdesk.marketplace-health": { sizes: ["md", "lg"], def: "md" },
      "flipdesk.consignor-payouts": { sizes: ["sm", "md"], def: "sm" },
    };
    for (const [id, want] of Object.entries(expected)) {
      const def = widgetById(id, registry)!;
      expect(def.sizes, id).toEqual(want.sizes);
      expect(def.defaultSize, id).toBe(want.def);
    }
  });

  it("adds none of them to the shipped board", () => {
    // Catalog-only. The board already opens with fourteen widgets and these
    // answer a weekly question, so they are in the Add-widget sheet instead of
    // pushing the queue off the first screen.
    for (const persona of ["seller", "consignment", "developer"] as const) {
      const ids = DEFAULT_LAYOUTS.flipdesk[persona].map((e) => e.id);
      for (const id of IDS) expect(ids, `${id} on ${persona}'s board`).not.toContain(id);
    }
  });

  it("offers every one of them in the catalog of an account that has consignors", () => {
    const context: LayoutContext = { hasConsignors: true };
    const offered = addableWidgets([], registry, "seller", context).map((w) => w.id);
    for (const id of IDS) expect(offered, id).toContain(id);
  });
});

describe("the windows each frame declares (AC2 and its five neighbours)", () => {
  it("gives ad spend the picker's phrase and nothing else that phrase", () => {
    expect(widgetById("flipdesk.ad-spend", registry)!.rangeAware).toBe(true);
    expect(widgetWindowPhrase(widgetById("flipdesk.ad-spend")!, "d30")).toBe(
      "in the last 30 days",
    );
    for (const id of IDS.filter((i) => i !== "flipdesk.ad-spend")) {
      expect(widgetById(id, registry)!.rangeAware, id).toBe(false);
    }
  });

  it("lets the two with a window of their own name it", () => {
    // eBay's Finances feed is a fixed 90 days whatever the picker says, and the
    // forecast looks a year FORWARD. "In the last 7 days" over either is the
    // defect overview-range.ts was written to prevent.
    expect(widgetWindowPhrase(widgetById("flipdesk.payouts")!, "d7")).toBe(
      "in the last 90 days",
    );
    expect(widgetWindowPhrase(widgetById("flipdesk.forecast")!, "d7")).toBe(
      "12 months ahead, from your own sales",
    );
  });

  it("says 'right now' on the three that are snapshots", () => {
    for (const id of [
      "flipdesk.equity",
      "flipdesk.marketplace-health",
      "flipdesk.consignor-payouts",
    ]) {
      expect(widgetWindowPhrase(widgetById(id)!, "d30"), id).toBe("right now");
    }
  });
});

describe("the board range as a day window (AC2)", () => {
  const NOW = new Date("2026-09-02T12:00:00Z");

  it("converts the three fixed ranges literally", () => {
    expect(overviewRangeDays("d7", NOW)).toBe(7);
    expect(overviewRangeDays("d30", NOW)).toBe(30);
    expect(overviewRangeDays("d90", NOW)).toBe(90);
  });

  it("counts year to date from January 1, not as a flat year", () => {
    const days = overviewRangeDays("ytd", new Date(2026, 0, 11, 12));
    expect(days).toBe(11);
  });

  it("answers null for all time rather than a large number", () => {
    // A caller with a maximum has to apply its own and say so. Handing back
    // 3650 would let a card print "all time" over the year eBay actually keeps.
    expect(overviewRangeDays("all", NOW)).toBeNull();
  });

  it("never returns zero days for a range that just opened", () => {
    expect(overviewRangeDays("ytd", new Date(2026, 0, 1, 0, 30))).toBe(1);
  });
});

describe("the consignor widget leaves an account that has no consignors (AC6)", () => {
  const stored = {
    version: 1,
    widgets: [
      { id: "flipdesk.consignor-payouts", size: "sm" },
      { id: "flipdesk.north-star", size: "sm" },
    ],
  };

  it("removes it from a saved layout, and from the catalog too", () => {
    const context: LayoutContext = { hasConsignors: false };
    expect(normalize(stored, registry, "seller", context).map((e) => e.id)).toEqual([
      "flipdesk.north-star",
    ]);
    // Removed from the board and offered straight back is a loop with a button
    // on it, which is why addableWidgets applies omitWhen too.
    expect(
      addableWidgets([], registry, "seller", context).map((w) => w.id),
    ).not.toContain("flipdesk.consignor-payouts");
  });

  it("keeps it while the count has not answered, and once it has consignors", () => {
    for (const context of [{}, { hasConsignors: true }] as LayoutContext[]) {
      expect(
        normalize(stored, registry, "seller", context).map((e) => e.id),
        JSON.stringify(context),
      ).toContain("flipdesk.consignor-payouts");
    }
  });

  it("removes nothing else on an account with no consignors", () => {
    const all = registry.filter(
      (w) => !w.omitWhen?.({ hasConsignors: false }),
    ).length;
    expect(all).toBe(registry.length - 1);
  });
});

describe("summarizeDuePayouts (AC6)", () => {
  const row = (
    consignor_id: string,
    status: ConsignorPayoutStatus,
    amount: number,
  ): ConsignorPayoutRow => ({ consignor_id, status, amount }) as ConsignorPayoutRow;

  it("counts consignors, not payouts, and adds up what is owed", () => {
    const out = summarizeDuePayouts([
      row("a", "pending", 20),
      row("a", "pending", 5.5),
      row("b", "failed", 12),
    ]);
    expect(out).toEqual({ consignors: 2, payouts: 3, totalDue: 37.5 });
  });

  it("counts a transfer in flight as still owed", () => {
    // "Nobody is owed" while money is mid-transfer reads as a clear ledger.
    expect(summarizeDuePayouts([row("a", "processing", 9)]).consignors).toBe(1);
  });

  it("ignores everything that is finished, and the reversal direction", () => {
    const out = summarizeDuePayouts([
      row("a", "paid", 40),
      row("b", "canceled", 10),
      row("c", "reversed", 10),
      // Money owed BACK to the seller after a sale reversed. Adding it to
      // "consignors owed" would point the arrow the wrong way.
      row("d", "clawback_pending", 30),
    ]);
    expect(out).toEqual({ consignors: 0, payouts: 0, totalDue: 0 });
  });
});
