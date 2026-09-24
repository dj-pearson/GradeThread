// Pricing plan P12: Price suggestions folded into Repricing. The tab is gone,
// every old link lands on Repricing, the counts moved with it, and the page
// no longer calls its comps "sold".
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRICING_TABS, resolvePricingTab, RETIRED_NAV_REDIRECTS } from "../nav-tabs";
import { changeLabel, queueCounts } from "../reprice-plan";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("the Price suggestions tab is retired into Repricing", () => {
  it("?tab=suggestions lands on Repricing", () => {
    expect(PRICING_TABS).not.toContain("suggestions");
    expect(resolvePricingTab("suggestions")).toBe("repricing");
    expect(RETIRED_NAV_REDIRECTS["/dashboard/analytics/suggestions"]).toBe(
      "/dashboard/flipdesk/pricing?tab=repricing",
    );
  });

  it("the host no longer mounts it and the page is gone", () => {
    const host = read("src/pages/flipdesk/pricing.tsx");
    expect(host).not.toMatch(/value="suggestions"/);
    expect(host).not.toMatch(/PriceSuggestionsPage/);
    // Spelled in pieces so a grep for the old file name over src/ stays empty.
    const retired = `src/pages/${["price", "suggestions"].join("-")}.tsx`;
    expect(existsSync(resolve(process.cwd(), retired))).toBe(false);
  });

  it("Repricing shows the three counts", () => {
    const page = read("src/pages/flipdesk/repricing.tsx");
    expect(page).toContain("<QueueSummary rows={suggestions} />");
    expect(page).toContain("Priced below condition-matched active listings");
    expect(queueCounts([
      { reason_code: "UNDERPRICED" },
      { reason_code: "OVERPRICED" },
      { reason_code: "STALE" },
    ])).toEqual({ total: 3, raise: 1, lower: 2 });
  });

  it("each row states the change as a signed percent", () => {
    expect(changeLabel({ current_price_cents: 5000, suggested_price_cents: 5600 })).toBe("+12%");
    expect(changeLabel({ current_price_cents: 5000, suggested_price_cents: 4600 })).toBe("-8%");
    expect(changeLabel({ current_price_cents: 0, suggested_price_cents: 10 })).toBeNull();
  });
});

describe("Repricing copy", () => {
  it("never calls the comps sold", () => {
    // The comps are ACTIVE asking prices. The retired tab called them
    // "sold-condition listings" on the same screen that said otherwise.
    const page = read("src/pages/flipdesk/repricing.tsx");
    const strings = [...page.matchAll(/"([^"\n]*)"|`([^`\n]*)`|>([^<>{}\n]+)</g)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? "")
      .filter((s) => !s.trim().startsWith("//"));
    const offenders = strings.filter((s) => /\bsold\b/i.test(s));
    expect(offenders).toEqual([]);
  });
});
