// US-439: WCAG 2.1 relative-luminance + contrast-ratio helpers used by the
// documented contrast check (see contrast.test.ts). Pure functions, no deps.

export type RGB = [number, number, number];

/** Parse a #rrggbb (or #rgb) hex string into an [r,g,b] tuple (0–255). */
export function hexToRgb(hex: string): RGB {
  let c = hex.replace("#", "").trim();
  if (c.length === 3)
    c = c
      .split("")
      .map((ch) => ch + ch)
      .join("");
  const n = parseInt(c, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Composite a foreground color at `alpha` over an opaque background. */
export function compositeOver(fg: RGB, alpha: number, bg: RGB): RGB {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

/** WCAG relative luminance of an sRGB color. */
function relativeLuminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1–21) between two colors (hex or RGB). Order-agnostic. */
export function contrastRatio(a: string | RGB, b: string | RGB): number {
  const la = relativeLuminance(typeof a === "string" ? hexToRgb(a) : a);
  const lb = relativeLuminance(typeof b === "string" ? hexToRgb(b) : b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA threshold for normal-size text. */
export const AA_NORMAL = 4.5;
/** WCAG AA threshold for large text (>=18.66px bold / 24px regular). */
export const AA_LARGE = 3;
