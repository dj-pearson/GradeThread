// A6: one theme for the FlipDesk analytics charts.
//
// TOOLTIPS. The theme tokens in src/index.css are hex (`--card: #ffffff`), so
// `var(--card)` is `hsl(#ffffff)`, which is invalid CSS. The declaration is
// dropped and the tooltip draws with no background and no border. Use the
// variable directly. src/test/chart-hsl-guard.test.ts keeps it that way.
//
// SERIES. Brand navy #0F3460 is a UI colour, not a data colour: on the dark card
// (#0c1e36) it is about 1.1:1 and the bars disappear. #3B72D9 is the step of the
// same hue that condition-curve-chart.tsx already validated. #12A37F is the
// profit hue, deliberately not brand red, because red reads as a loss. The pair
// was run through the dataviz validator against both surfaces: every check
// passes (normal-vision dE 22.3, deutan dE 21.2, tritan 8.0, 3:1 contrast on
// #ffffff and on #0c1e36). NEGATIVE is brand red, for values below zero only.

import type { CSSProperties } from "react";

export const CHART_TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: "var(--card)",
  color: "var(--card-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

export const SERIES = {
  primary: "#3B72D9",
  profit: "#12A37F",
  negative: "#E94560",
} as const;

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const USD_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Axis ticks: whole dollars, sign first ("-$12", not "-12$" or "$-12"). */
export function usdTick(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? USD.format(n) : "";
}

/** Tooltip values: dollars and cents. */
export function usdExact(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? USD_CENTS.format(n) : "-";
}

/** Percent ticks for values already on a 0-100 scale. */
export function pctTick(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)}%` : "";
}
