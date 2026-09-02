// US-3076: the formatting the FlipDesk Overview widgets share.
//
// The Overview used to be one file, so these were three local functions beside
// the markup that used them. It is thirteen widget modules now, and a dollar
// sign rendered three different ways across one board is exactly the drift a
// shared helper exists to stop. Pure, so it lives in lib and not beside a
// component.

/** Rows a list widget previews before "show all" (US-2547). */
export const PREVIEW_ROWS = 5;

/**
 * Money, to the cent.
 *
 * A missing number is $0.00 rather than a dash: every figure here is a sum over
 * the seller's own rows, and the sum of no rows is zero, not unknown.
 */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

/** Money, rounded, for the smaller figure that sits under a headline number. */
export function fmtMoneyShort(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "$0";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}
