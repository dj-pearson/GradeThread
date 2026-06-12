import { describe, it, expect } from "vitest";
import {
  contrastRatio,
  compositeOver,
  hexToRgb,
  AA_NORMAL,
  AA_LARGE,
} from "@/lib/a11y/contrast";

// US-439 — documented contrast check.
//
// These assertions are the regression guard for the theme color tokens defined
// in src/index.css. If a token below is changed, this test must be updated with
// the new measured ratio so contrast regressions are caught in CI.
//
// Theme surfaces (from index.css):
const LIGHT_BG = "#fafafc"; // --background (light)
const LIGHT_CARD = "#ffffff"; // --card (light)
const DARK_BG = "#0e0e1a"; // --background (dark)
const DARK_CARD = "#0c1e36"; // --card (dark)
const WHITE = "#ffffff";

// Functional reds (from index.css, US-439):
const DESTRUCTIVE_LIGHT = "#cc1f3d"; // --destructive / --brand-red-text (light)
const DESTRUCTIVE_DARK = "#fb5e78"; // --destructive / --brand-red-text (dark)
const BRAND_RED_BG = "#cc1f3d"; // --color-brand-red (bg/CTA, fixed both themes)

// Muted foreground (from index.css):
const MUTED_FG_LIGHT = "#64748b"; // --muted-foreground (light)
const MUTED_FG_DARK = "#94a3b8"; // --muted-foreground (dark)

describe("US-439 red CTA / destructive text contrast (AA >= 4.5:1)", () => {
  it("destructive/red text passes AA on light surfaces", () => {
    expect(contrastRatio(DESTRUCTIVE_LIGHT, LIGHT_BG)).toBeGreaterThanOrEqual(
      AA_NORMAL
    );
    expect(contrastRatio(DESTRUCTIVE_LIGHT, LIGHT_CARD)).toBeGreaterThanOrEqual(
      AA_NORMAL
    );
  });

  it("destructive/red text passes AA on dark surfaces", () => {
    expect(contrastRatio(DESTRUCTIVE_DARK, DARK_BG)).toBeGreaterThanOrEqual(
      AA_NORMAL
    );
    expect(contrastRatio(DESTRUCTIVE_DARK, DARK_CARD)).toBeGreaterThanOrEqual(
      AA_NORMAL
    );
  });

  it("white text on a bg-brand-red CTA passes AA in both themes (color is fixed)", () => {
    // bg-brand-red is a fixed color, so the same ratio holds in light and dark.
    expect(contrastRatio(WHITE, BRAND_RED_BG)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("white text on the dark destructive button (bg-destructive/60 over card) passes AA", () => {
    // shadcn destructive button uses dark:bg-destructive/60.
    const buttonBg = compositeOver(hexToRgb(DESTRUCTIVE_DARK), 0.6, hexToRgb(DARK_CARD));
    expect(contrastRatio(WHITE, buttonBg)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe("US-439 muted-foreground contrast (AA >= 4.5:1)", () => {
  it("passes AA on light surfaces", () => {
    expect(contrastRatio(MUTED_FG_LIGHT, LIGHT_BG)).toBeGreaterThanOrEqual(
      AA_NORMAL
    );
  });
  it("passes AA on dark surfaces", () => {
    expect(contrastRatio(MUTED_FG_DARK, DARK_BG)).toBeGreaterThanOrEqual(
      AA_NORMAL
    );
    expect(contrastRatio(MUTED_FG_DARK, DARK_CARD)).toBeGreaterThanOrEqual(
      AA_NORMAL
    );
  });
});

describe("US-439 regression: the OLD vibrant red fails as text (documents why it changed)", () => {
  it("the previous brand red #f03d5f did NOT meet AA as text on white", () => {
    expect(contrastRatio("#f03d5f", LIGHT_CARD)).toBeLessThan(AA_NORMAL);
    // ...but still cleared the large-text threshold, hence it survives as a
    // decorative/large accent where appropriate.
    expect(contrastRatio("#f03d5f", LIGHT_CARD)).toBeGreaterThanOrEqual(AA_LARGE);
  });
});

describe("contrast helper sanity", () => {
  it("black on white is 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });
  it("is order-agnostic", () => {
    expect(contrastRatio("#123456", "#abcdef")).toBeCloseTo(
      contrastRatio("#abcdef", "#123456"),
      5
    );
  });
});
