import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  sellThroughDatum,
  sellThroughTooltip,
  type SellThroughRow,
} from "@/lib/flipdesk-analytics";

// A7: "no listings in range" is not 0%, and over 100% is marked, not hidden.

const row = (over: Partial<SellThroughRow>): SellThroughRow => ({
  group: "Outerwear",
  listed: 10,
  sold: 4,
  sellThrough: 0.4,
  avgNetProfit: null,
  medianDaysToSell: null,
  ...over,
});

describe("sellThroughDatum", () => {
  it("keeps a null rate null when listed is 0 and sold is 5", () => {
    const d = sellThroughDatum(row({ listed: 0, sold: 5, sellThrough: null }));
    expect(d.rate).toBeNull();
    expect(sellThroughTooltip(d)).toBe("no listings in range (5 sold / 0 listed)");
  });

  it("keeps a 140% row at 140 and always shows the counts", () => {
    const d = sellThroughDatum(row({ listed: 5, sold: 7, sellThrough: 1.4 }));
    expect(d.rate).toBe(140);
    expect(sellThroughTooltip(d)).toBe("140% (7 sold / 5 listed)");
  });
});

describe("the chart stops at 100% and marks overflow", () => {
  it("caps the drawn bar at 100 and labels bars past it with the real rate", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/flipdesk/sell-through-chart.tsx"),
      "utf8",
    );
    expect(src).toContain("domain={[0, 100]}");
    // The bar reads a copy capped at 100; the label reads the real rate. With
    // allowDataOverflow the bar end, and so the label, sat outside the plot.
    expect(src).not.toContain("allowDataOverflow");
    expect(src).toContain("Math.min(d.rate, 100)");
    expect(src).toContain('<Bar dataKey="bar"');
    expect(src).toMatch(/<LabelList\s+dataKey="rate"/);
    expect(src).toMatch(/v > 100 \? `\$\{v\}%\*`/);
  });
});
