// US-3076: the formatting the FlipDesk Overview widgets share.
//
// The Overview used to be one file, so these were three local functions beside
// the markup that used them. It is thirteen widget modules now, and a dollar
// sign rendered three different ways across one board is exactly the drift a
// shared helper exists to stop. Pure, so it lives in lib and not beside a
// component.

/** Rows a list widget previews before "show all" (US-2547). */
export const PREVIEW_ROWS = 5;

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const USD_COMPACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const USD_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * Money, to the cent, with grouping and the sign before the symbol:
 * "$48,213.50" and "-$12.40", never "$48213.50" or "$-12.40".
 *
 * A missing number is $0.00 rather than a dash: every figure here is a sum over
 * the seller's own rows, and the sum of no rows is zero, not unknown.
 */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "$0.00";
  return USD.format(n);
}

/** Money, rounded, for the smaller figure that sits under a headline number. */
export function fmtMoneyShort(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "$0";
  if (Math.abs(n) >= 1000) return USD_COMPACT.format(n);
  return USD_WHOLE.format(n);
}

/**
 * A row's display name. An untitled item used to render as an empty link,
 * which is a click target with nothing to read.
 */
export function itemLabel(row: {
  item_title?: string | null;
  brand?: string | null;
}): string {
  return row.item_title?.trim() || row.brand?.trim() || "Untitled item";
}

/**
 * A sale date in the viewer's locale. A bare YYYY-MM-DD is a calendar day, so
 * it is built as a LOCAL date: parsing it as an instant would put it at UTC
 * midnight and show the previous day west of Greenwich. A full timestamp is a
 * real instant and is shown as the viewer's local day.
 */
export function fmtSaleDate(value: string | null | undefined): string {
  if (!value) return "";
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}
