import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DASHBOARD_SURFACES,
  DEFAULT_LAYOUTS,
  PROMOTIONAL_WIDGET_IDS,
  WIDGET_PERSONAS,
  widgetById,
} from "@/lib/dashboard-widgets";

// US-2537, re-expressed against the widget board (US-3075 AC4).
//
// The seller dashboard opened with eight promotional blocks - the activation
// checklist, a first-run card, quick actions, the rewards widget, a FlipDesk
// promo, Discover cards, invite-a-friend and an impact tile - before a
// returning seller saw a single number about their own business.
//
// That used to be a claim about the ORDER OF JSX in src/pages/dashboard.tsx,
// and asserting it meant reading the file and comparing character offsets.
// There is no order in that file any more: the page renders one board and the
// order lives in DEFAULT_LAYOUTS, per persona, as data. So does the assertion.
// It now covers every persona rather than the one the page happened to be
// written for, and it holds for a widget added by a later story without anyone
// remembering to edit this test.

const METER = "src/components/billing/usage-meter.tsx";

/** Every shipped default, named so a failure says which one broke. */
function everyDefault(): Array<{
  name: string;
  entries: readonly { id: string; size: string }[];
}> {
  const out: Array<{ name: string; entries: readonly { id: string; size: string }[] }> =
    [];
  for (const surface of DASHBOARD_SURFACES) {
    for (const persona of WIDGET_PERSONAS) {
      out.push({
        name: `${surface}/${persona}`,
        entries: DEFAULT_LAYOUTS[surface][persona],
      });
    }
  }
  return out;
}

describe("the seller's own data comes first (US-2537, US-3075 AC4)", () => {
  it("puts every promotional widget below every data widget, in every default", () => {
    for (const { name, entries } of everyDefault()) {
      const dataIndexes: number[] = [];
      const promoIndexes: number[] = [];

      entries.forEach((entry, index) => {
        if (PROMOTIONAL_WIDGET_IDS.includes(entry.id)) {
          promoIndexes.push(index);
          return;
        }
        // Not everything that is not promotional is data: `grading.passports`
        // is a feature surface the catalog files under promo and the invariant
        // does not constrain. The registry's own category is the authority.
        if (widgetById(entry.id)?.category === "data") dataIndexes.push(index);
      });

      if (dataIndexes.length === 0 || promoIndexes.length === 0) continue;

      const lastData = Math.max(...dataIndexes);
      const firstPromo = Math.min(...promoIndexes);
      expect(
        firstPromo,
        `${name}: ${entries[firstPromo]?.id} sits above ${entries[lastData]?.id}`,
      ).toBeGreaterThan(lastData);
    }
  });

  it("names a registered widget in PROMOTIONAL_WIDGET_IDS", () => {
    // A typo here would silently exempt a widget from the rule above rather
    // than fail, which is the one way this test could pass while being wrong.
    for (const id of PROMOTIONAL_WIDGET_IDS) {
      expect(widgetById(id), `${id} is not registered`).toBeDefined();
    }
  });

  it("opens the seller's board with the queue, not with a promotion", () => {
    const seller = DEFAULT_LAYOUTS.grading.seller;
    expect(seller[0]?.id).toBe("grading.usage");
    expect(seller[1]?.id).toBe("grading.queue");
    expect(seller[2]?.id).toBe("grading.attention");
  });

  it("keeps the page itself down to the banner and the board", () => {
    // The PWA banner is the one thing allowed above the board: an install
    // affordance tied to real intent, not a promotion of another product, and
    // it disappears once dismissed or installed.
    const page = readFileSync(
      resolve(process.cwd(), "src/pages/dashboard.tsx"),
      "utf8",
    );
    expect(page).toContain("<PwaInstallBanner");
    expect(page).toContain("<CustomizableWidgetBoard");
    // CustomizableWidgetBoard renders PageHeader itself so the Customize
    // action can sit beside the page's actions. A second one here would be two
    // headers on one page.
    expect(page).not.toContain("<PageHeader");
  });
});

describe("usage is rendered once (US-2537, US-3075 AC4)", () => {
  it("puts grading.usage on a layout at most once", () => {
    for (const { name, entries } of everyDefault()) {
      const uses = entries.filter((e) => e.id === "grading.usage").length;
      expect(uses, `${name} carries grading.usage ${uses} times`).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("the hand-built Grades Used card is gone", () => {
    const page = readFileSync(
      resolve(process.cwd(), "src/pages/dashboard.tsx"),
      "utf8",
    );
    expect(page).not.toContain(">Grades Used<");
    // And with it the local arithmetic that duplicated the meter's.
    expect(page).not.toMatch(/const gradesPercent/);
    expect(page).not.toMatch(/const gradesUsed/);
  });

  it("the shared meter cannot divide by zero", () => {
    // This is why the duplicate had to go rather than be fixed in place: the
    // removed card computed used / limit with no guard, so a Free plan
    // (includedStandardGradesPerMonth === 0) produced Infinity and rendered
    // "Infinity%" on a new account's very first visit. The shared meter floors
    // the divisor at 1 and clamps the result.
    const meter = readFileSync(resolve(process.cwd(), METER), "utf8");
    expect(meter).toMatch(/used \/ Math\.max\(limit, 1\)/);
  });
});

describe("the quick actions go straight there (US-2537)", () => {
  const ACTIONS = "src/lib/dashboard-persona-cards.ts";

  it("Add Inventory Item targets the intake page, not a redirect", () => {
    const text = readFileSync(resolve(process.cwd(), ACTIONS), "utf8");
    expect(text).toContain('to: "/dashboard/flipdesk/intake"');
    expect(text).not.toContain('to: "/dashboard/inventory/new"');
  });

  it("the redirect it used to use still exists for old links", () => {
    // Removing the quick action's hop must not break a bookmark or an email.
    const routes = readFileSync(
      resolve(process.cwd(), "src/routes/index.tsx"),
      "utf8",
    );
    expect(routes).toMatch(
      /path: "\/dashboard\/inventory\/new"[\s\S]{0,120}?\/dashboard\/flipdesk\/intake/,
    );
  });
});
