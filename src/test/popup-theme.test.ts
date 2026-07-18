// US-1884 AC4: the unified extension popup's dark theme.
//
// The popup shipped light-only — a 340px white flash on a dark OS, next to an
// overlay that was already dark-themed.
//
// WHY THIS IS TESTABLE AND THE REST OF AC4 IS NOT. AC4's other half (hardening the
// overlay's children against site CSS bleeding in) genuinely needs a browser on
// real marketplace pages — you cannot observe bleed headlessly. The popup has no
// site: it is the extension's own document in its own context, so nothing can bleed
// into it and the only question is whether the palette is complete. That is exactly
// what a stylesheet can answer.
//
// The rules below are asserted through a real CSS parser rather than by grepping,
// because a block can be present in the file and still not apply.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CSS = readFileSync(
  resolve(__dirname, "..", "..", "extension-unified", "popup.css"),
  "utf8",
);

let darkRule: CSSMediaRule;
let darkSelectors: string[];

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const sheet = document.styleSheets[document.styleSheets.length - 1];
  expect(sheet, "the stylesheet must attach").toBeDefined();
  const media = Array.from(sheet!.cssRules).filter(
    (r): r is CSSMediaRule =>
      r.type === CSSRule.MEDIA_RULE &&
      /prefers-color-scheme:\s*dark/.test((r as CSSMediaRule).media.mediaText),
  );
  expect(media, "popup.css must have exactly one prefers-color-scheme:dark block").toHaveLength(1);
  darkRule = media[0]!;
  darkSelectors = Array.from(darkRule.cssRules).map(
    (r) => (r as CSSStyleRule).selectorText,
  );
});

/**
 * Relative luminance of a CSS colour, 0 (black) → 1 (white).
 *
 * The pills are asserted on CONTRAST, not on specific hex values, because the
 * invariant is "light ink on a dark chip" — not "not #137333". An earlier version
 * of this test matched the hex and could never fire: the CSSOM normalises colours
 * to rgb(), so the regex looked correct and silently passed against the very bug it
 * was written to catch.
 */
function luminance(css: string): number {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(css);
  if (!m) return NaN;
  const lin = (raw: string | undefined) => {
    const c = Number(raw ?? 0) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
}

// Match a rule whose selector LIST contains `selector`, not one whose whole
// selectorText equals it. Grouping is ordinary CSS — when US-1885 added the
// pending-delists card it correctly reused the last-job card's theming as
// `.pop-lastjob, .pop-delists { … }`, and an exact-equality lookup read that as
// "no dark override for .pop-lastjob" and failed. The rule was right; the
// assertion was too literal about how it was written.
function darkStyle(selector: string): CSSStyleDeclaration {
  const rule = Array.from(darkRule.cssRules).find((r) => {
    const text = (r as CSSStyleRule).selectorText;
    if (!text) return false;
    return text.split(",").some((s) => s.trim() === selector);
  }) as CSSStyleRule | undefined;
  expect(rule, `expected a dark override for ${selector}`).toBeDefined();
  return rule!.style;
}

describe("US-1884 AC4: popup dark theme", () => {
  it("parses as a real media query and themes the page surface", () => {
    expect(darkSelectors.length).toBeGreaterThan(10);
    expect(darkStyle("body").background || darkStyle("body").backgroundColor).toBeTruthy();
  });

  it("re-inks the semantic pills instead of inverting them", () => {
    // These are pale-tint + dark-ink in light. A naive invert leaves near-black ink
    // on a near-black chip — present, and unreadable. Each must carry BOTH a new
    // background and a new colour.
    for (const sel of [".pop-status.on", ".pop-status.off", ".pop-status.warn"]) {
      const s = darkStyle(sel);
      const bg = luminance(s.background || s.backgroundColor);
      const fg = luminance(s.color);
      expect(bg, `${sel} needs a dark tint`).toBeLessThan(0.2);
      expect(fg, `${sel} needs LIGHT ink — keeping the light theme's dark ink leaves ` +
        "near-black text on a near-black chip: present, and unreadable").toBeGreaterThan(0.3);
      expect(fg, `${sel} ink must out-contrast its chip`).toBeGreaterThan(bg);
    }
  });

  it("themes every pill variant that exists in light", () => {
    // A new .pop-status.<variant> added without a dark override is the likeliest
    // future regression — US-1885 added .warn, and it would have been missed.
    const variants = Array.from(CSS.matchAll(/\.pop-status\.([a-z-]+)\s*\{/g))
      .map((m) => m[1])
      .filter((v, i, a) => a.indexOf(v) === i);
    expect(variants.length).toBeGreaterThanOrEqual(3);
    for (const v of variants) {
      expect(
        darkSelectors,
        `.pop-status.${v} exists in light but has no dark override`,
      ).toContain(`.pop-status.${v}`);
    }
  });

  it("supplies the last-job block's themed vars rather than restating its rules", () => {
    // The block reads var(--pop-border)/var(--pop-subtle) with light fallbacks, so
    // dark only has to provide values.
    const s = darkStyle(".pop-lastjob");
    expect(s.getPropertyValue("--pop-border").trim()).toBeTruthy();
    expect(s.getPropertyValue("--pop-subtle").trim()).toBeTruthy();
  });

  it("overrides the muted/line palette at :root so var() consumers follow", () => {
    // The point of doing it here: .pop-acct-sub, .pop-empty, .pop-read-meta and
    // friends all read var(--muted) and must NOT need their own dark rules.
    const s = darkStyle(":root");
    expect(s.getPropertyValue("--muted").trim()).toBeTruthy();
    expect(s.getPropertyValue("--line").trim()).toBeTruthy();
  });

  it("leaves the light theme intact", () => {
    // A syntax error in the appended block would silently swallow later rules.
    document.body.className = "";
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(255, 255, 255)");
  });
});
