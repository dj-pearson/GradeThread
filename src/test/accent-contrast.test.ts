import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2334 AC1/AC4: the accent pair has to clear AA, and it has to keep clearing
// it after the next person edits a token.
//
// What was wrong: --accent was the vibrant brand red #f03d5f with white
// foreground, at 3.79:1. That pair is not decorative — shadcn paints it on
// button outline/ghost hover, badge hover, dropdown items and the command
// palette's selected row, all of which carry small text.
//
// The fix keeps the brand red as the brand red (bg-brand-red, --chart-2, the
// sidebar) and makes --accent what shadcn means by accent: a subtle surface. So
// the guard has to check the PAIR, in both themes, rather than any one value —
// and it recomputes the ratio from the CSS rather than trusting the comment
// beside it, because a comment claiming 4.75:1 is exactly what a broken token
// would still say.

const CSS = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

const AA_NORMAL = 4.5;

function relativeLuminance(hex: string): number {
  const c = hex.replace("#", "");
  const channels = [0, 2, 4]
    .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Read a token out of the `:root {…}` block or the `.dark {…}` block. */
function token(name: string, theme: "light" | "dark"): string {
  const block = theme === "light"
    ? CSS.slice(CSS.indexOf(":root {"), CSS.indexOf(".dark {"))
    : CSS.slice(CSS.indexOf(".dark {"));
  const m = block.match(new RegExp(`^\\s*--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "m"));
  if (!m) throw new Error(`--${name} not found as a hex literal in the ${theme} block`);
  return m[1]!;
}

describe("the accent pair clears AA in both themes", () => {
  it("light", () => {
    const ratio = contrast(token("accent-foreground", "light"), token("accent", "light"));
    expect(ratio, `accent-foreground on accent is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it("dark", () => {
    const ratio = contrast(token("accent-foreground", "dark"), token("accent", "dark"));
    expect(ratio, `accent-foreground on accent is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it("the vibrant brand red is not the accent surface again", () => {
    // The specific regression: #f03d5f with white text reads as a confident
    // brand choice and fails at 3.79:1. Named rather than inferred, so the
    // failure message says what happened.
    for (const theme of ["light", "dark"] as const) {
      expect(token("accent", theme).toLowerCase(), `${theme} --accent`).not.toBe("#f03d5f");
    }
  });
});

describe("the hover surface is still visible", () => {
  // The trap found while picking the dark value: a darker wash scores better
  // under text and disappears against the navy card. A hover state nobody can
  // see is not an accessibility win, it is a different defect. 1.1:1 is the
  // floor at which the wash reads as a distinct surface.
  it("dark accent is distinguishable from the card it sits on", () => {
    const ratio = contrast(token("accent", "dark"), token("card", "dark"));
    expect(ratio, `accent vs card is ${ratio.toFixed(2)}:1`).toBeGreaterThan(1.1);
  });

  it("light accent is distinguishable from the page background", () => {
    const ratio = contrast(token("accent", "light"), token("background", "light"));
    expect(ratio, `accent vs background is ${ratio.toFixed(2)}:1`).toBeGreaterThan(1.1);
  });
});

describe("the guard reads the file, not a memory of it", () => {
  it("resolves the tokens it claims to check", () => {
    // Guards the guard: a renamed block or a var() indirection would make every
    // assertion above pass over nothing.
    for (const theme of ["light", "dark"] as const) {
      expect(token("accent", theme)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(token("accent-foreground", theme)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("computes a known ratio correctly", () => {
    // Black on white is 21:1 by definition. If this drifts, every number above
    // is wrong in the same direction and would still look plausible.
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
});
