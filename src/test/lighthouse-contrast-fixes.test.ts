// Two color-contrast failures Lighthouse reported on the static pages, pinned
// so they cannot come back one className at a time.
//
//   /            the sample certificate's scores: text-emerald-500 (overall,
//                2.45:1) and text-emerald-600 (factor scores, 3.62:1) on the
//                light card. They now use the theme-inverting
//                --grade-green-text token.
//   /developers  inline <code> inherited the Section's text-muted-foreground
//                and sat on bg-muted: #64748b on #f0f4f8, 4.3:1. Each chip now
//                sets text-foreground.
//
// The ratios are computed from the real tokens in src/index.css, so a palette
// change that drops either below AA (4.5:1) fails here first.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const css = read("src/index.css");

/** The body of the first top-level `<selector> {` block. */
function blockBody(selector: string): string {
  const at = css.indexOf(selector + " {");
  if (at === -1) throw new Error(`no block for ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}
function token(block: string, name: string): string {
  const v = new RegExp(`^\\s*${name}\\s*:\\s*(#[0-9a-f]{6})\\s*;`, "mi").exec(
    blockBody(block),
  )?.[1];
  if (!v) throw new Error(`${name} is not a hex color in ${block}`);
  return v;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const THEMES = [":root", ".dark"] as const;

describe("sample certificate scores clear AA (Lighthouse, /)", () => {
  const landing = read("src/pages/landing.tsx");
  const fn = landing.slice(
    landing.indexOf("function SampleCertificatePreview"),
    landing.indexOf("function", landing.indexOf("function SampleCertificatePreview") + 10),
  );

  it("the overall and factor scores use the grade-green text token", () => {
    const overall = /<span data-cert-score className="([^"]*)"/.exec(fn)?.[1];
    const factor = /<span data-cert-factor-score className="([^"]*)"/.exec(fn)?.[1];
    expect(overall).toContain("text-grade-green-text");
    expect(factor).toContain("text-grade-green-text");
    // No raw emerald text anywhere in the certificate; rings and bars may
    // keep the brighter emerald since they are not text.
    expect(fn).not.toMatch(/\btext-emerald-(400|500|600)\b/);
  });

  for (const theme of THEMES) {
    it(`--grade-green-text is >= 4.5:1 on card and background (${theme})`, () => {
      const green = token(theme, "--grade-green-text");
      expect(contrast(green, token(theme, "--card"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(green, token(theme, "--background"))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("/developers inline code clears AA (Lighthouse)", () => {
  const dev = read("src/pages/marketing/developers.tsx");
  // Inline chips only; <pre><code> blocks carry their own slate palette.
  const chips = [...dev.matchAll(/<code className="([^"]*)"/g)].map((m) => m[1]!);

  it("finds the chips it is checking (self-check)", () => {
    expect(chips.length).toBeGreaterThan(20);
  });

  it("every bg-muted code chip sets text-foreground", () => {
    const bad = chips.filter(
      (c) => /\bbg-muted\b/.test(c) && !/(^|\s)text-foreground(\s|$)/.test(c),
    );
    expect(bad).toEqual([]);
  });

  for (const theme of THEMES) {
    it(`foreground on muted is >= 4.5:1, muted-foreground was not (${theme})`, () => {
      const muted = token(theme, "--muted");
      expect(contrast(token(theme, "--foreground"), muted)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("records why: muted-foreground on muted is under AA in light mode", () => {
    expect(
      contrast(token(":root", "--muted-foreground"), token(":root", "--muted")),
    ).toBeLessThan(4.5);
  });
});
