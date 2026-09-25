// DEV-15: the same header-text choice the embed widget makes
// (functions/embed/grade/widget.ts headerTextColor), for the white-label panel
// to warn with. The Pages Function cannot import from src/, so this is a copy;
// src/test/embed-grade-widget.test.ts fails if the two ever disagree.

function relativeLuminance(hex: string): number {
  const n = hex.replace("#", "");
  const channel = (i: number) => {
    const v = parseInt(n.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

export function brandHeaderContrast(hex: string): { text: "#fff" | "#0f172a"; ratio: number } | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const bg = relativeLuminance(hex);
  const white = contrastRatio(bg, 1);
  const dark = contrastRatio(bg, relativeLuminance("#0f172a"));
  return white >= dark ? { text: "#fff", ratio: white } : { text: "#0f172a", ratio: dark };
}
