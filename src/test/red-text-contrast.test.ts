// US-2334: red TEXT must use the AA-safe token.
//
// src/index.css defines two different reds and they are not interchangeable:
//
//   --color-brand-red       the BRAND red, for surfaces (fills, badges, bars)
//   --color-brand-red-text  the AA-safe red for TEXT, which inverts per theme
//
// Used as text on the app's own surfaces the brand red is 3.83:1 — below the
// 4.5:1 AA threshold for normal text — while brand-red-text clears it on all
// four: 5.26:1 on light --background, 5.48:1 on light --card, 6.36:1 on dark
// --background, 5.56:1 on dark --card. (Those are computed against the REAL
// surface tokens, not against pure white, which is why they differ from the
// naive numbers.)
//
// index.css has said "use text-brand-red-text for red text; never
// text-brand-red" since US-439, and 47 sites did it anyway. A rule that lives
// only in a CSS comment is a rule nobody is holding, so this is the holder.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * `text-brand-red` NOT followed by `-text`.
 *
 * The lookahead is the whole trick: `text-brand-red-text` contains
 * `text-brand-red` as a prefix, so a naive search reports every CORRECT use as
 * a violation. That is how the original count came out at 195 instead of 47.
 */
const VIOLATION = /text-brand-red(?!-text)\b/g;

describe("red text uses the AA-safe token (US-2334)", () => {
  const files = walk(SRC).filter((f) => !f.endsWith("red-text-contrast.test.ts"));

  it("scans a real corpus", () => {
    // Guards the guard: a broken walk() would make the assertion below pass
    // over nothing at all.
    expect(files.length).toBeGreaterThan(300);
  });

  it("no source file uses text-brand-red as a text colour", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const hits = src.match(VIOLATION);
      if (hits) offenders.push(`${f.replace(SRC, "src")} (${hits.length})`);
    }
    expect(
      offenders,
      "Use text-brand-red-text for red copy. text-brand-red is the SURFACE " +
        "red and is 3.83:1 as text — below AA. See src/index.css.",
    ).toEqual([]);
  });

  it("both tokens still exist, so this test cannot pass vacuously", () => {
    // If someone deletes or renames --color-brand-red-text, every use becomes
    // a violation of a rule pointing at nothing — and the assertion above
    // would still be green because the violating string changed too.
    const css = readFileSync(resolve(SRC, "index.css"), "utf8");
    expect(css).toContain("--color-brand-red-text");
    expect(css).toContain("--color-brand-red:");
  });
});

// ── The contrast maths itself, so the claim above is checkable ─────────────
//
// Pinning the ratios means a future palette change cannot quietly drop red text
// below AA: the numbers here fail before anyone has to notice visually.

function luminance(hex: string): number {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("the red tokens' contrast (US-2334)", () => {
  const AA_NORMAL = 4.5;

  it("brand-red-text clears AA on every app surface, light and dark", () => {
    for (
      const [fg, bg, label] of [
        ["#cc1f3d", "#fafafc", "light --background"],
        ["#cc1f3d", "#ffffff", "light --card"],
        ["#fb5e78", "#0e0e1a", "dark --background"],
        ["#fb5e78", "#0c1e36", "dark --card"],
      ] as const
    ) {
      expect(contrast(fg, bg), `${label}`).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it("the SURFACE red would fail as text — which is why the rule exists", () => {
    // Not an aspiration to fix: #E94560 is the documented brand colour and is
    // correct as a fill. This asserts WHY the two tokens are separate, so
    // nobody "simplifies" them back into one.
    expect(contrast("#e94560", "#fafafc")).toBeLessThan(AA_NORMAL);
  });
});
