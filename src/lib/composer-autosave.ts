// US-2634: the composer's Title and Price write themselves on edit.
//
// The Save button used to be the ONLY thing that moved either one into the
// database. Everything downstream reads the database — the Listings tab, the
// eBay push, and the Google Sheets sync, which pulls `inventory_items.title`
// for the Inventory tab and `listings.listing_price` for List Price. So a
// seller who fixed a title or a price and then navigated away left the ORIGINAL
// in the row, and the sheet kept syncing it. That read as a sync bug; it was a
// save that never happened.
//
// This module owns the DECISIONS only. The writes live in the composer (they
// need the supabase client and the resolved listing id); keeping the rules pure
// is what lets them be tested without mounting a 3000-line page.

/** How long typing has to stop before an edited field is written. */
export const AUTOSAVE_DELAY_MS = 1200;

interface AutosaveGate {
  /** False until the seed effect has filled the form — never save the seed. */
  initialised: boolean;
  /**
   * eBay owns both title and price on a listing IT created (US-2258). Both
   * inputs are disabled there, but the rule is repeated rather than assumed: a
   * future unlock must not turn into a silent write the server rejects.
   */
  isEbayOrigin: boolean;
  /** A full Save is in flight — it writes these too; don't race it. */
  saving: boolean;
}

export interface TitleAutosaveInput extends AutosaveGate {
  /** Current form value, untrimmed. */
  title: string;
  /** Last value known to be in the database, or null before the first seed. */
  lastSavedTitle: string | null;
}

/**
 * Whether the current title should be written to the database.
 *
 * Blank is deliberately NOT saved: `inventory_items.title` is NOT NULL, and
 * both explicit save paths already refuse an empty title. Clearing the box to
 * retype is a normal keystroke, not an instruction to erase the row's title.
 */
export function shouldAutosaveTitle(input: TitleAutosaveInput): boolean {
  if (!input.initialised || input.isEbayOrigin || input.saving) return false;
  const next = input.title.trim();
  if (!next) return false;
  return next !== (input.lastSavedTitle ?? "").trim();
}

/**
 * The price the box holds, as a number worth writing — or null.
 *
 * Zero and negatives are rejected on purpose. `resolveListingFields` picks the
 * first POSITIVE price precisely so a stray 0 can never shadow the item's
 * target price at publish; an autosave that wrote 0 would defeat that from the
 * other end. A half-typed "12." parses to 12 in JS, so the raw string is
 * required to end in a digit before it counts as a number the seller meant.
 */
export function parseAutosavePrice(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Currency, so two decimals — the column and eBay both round there anyway.
  return Math.round(n * 100) / 100;
}

export interface PriceAutosaveInput extends AutosaveGate {
  /** Current form value, as typed. */
  price: string;
  /** Last price known to be in the database, or null when the row has none. */
  lastSavedPrice: number | null;
}

/**
 * Whether the current price should be written. Compared as a NUMBER, so
 * "25.00" over a saved 25 is not a write — otherwise every visit to the field
 * would re-save the same money.
 */
export function shouldAutosavePrice(input: PriceAutosaveInput): boolean {
  if (!input.initialised || input.isEbayOrigin || input.saving) return false;
  const next = parseAutosavePrice(input.price);
  if (next === null) return false;
  return next !== input.lastSavedPrice;
}

/** What a self-saving field shows about its own persistence. */
export type FieldSaveState = "idle" | "saving" | "saved" | "error";
