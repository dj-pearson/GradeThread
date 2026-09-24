import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pctTick, usdExact, usdTick } from "@/lib/chart-theme";

describe("chart formatters (A6)", () => {
  it("puts the dollar sign before the number and the minus before the sign", () => {
    expect(usdTick(25)).toBe("$25");
    expect(usdTick(-12)).toBe("-$12");
    expect(usdExact(-12)).toBe("-$12.00");
    expect(pctTick(53.4)).toBe("53%");
  });
});

describe("condition curve does not bridge suppressed cohort grades (A6)", () => {
  it("has no connectNulls on the cohort band or cohort median", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/flipdesk/condition-curve-chart.tsx"),
      "utf8",
    );
    const block = (dataKey: string) => {
      const i = src.indexOf(`dataKey="${dataKey}"`);
      return src.slice(i, src.indexOf("/>", i));
    };
    expect(block("band")).not.toContain("connectNulls");
    expect(block("cohort")).not.toContain("connectNulls");
  });
});
