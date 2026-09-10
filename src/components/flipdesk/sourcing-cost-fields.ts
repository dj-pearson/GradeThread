// US-3193: the seller's own postage, packaging and grading figures, which the
// buy ceiling subtracts before it divides by the target return.
//
// SPLIT OUT OF THE COMPONENT ON PURPOSE. Migration 00770 added the three
// columns and the edge read them from day one, but nothing in the product could
// WRITE them, so every seller sat on the code defaults and the story's promise
// that these are "stored on flipdesk_settings, not hardcoded in the ceiling"
// held for nobody. The parsing is the part that decides whether a typed "8.30"
// becomes 830 or a Postgres 23514 in a toast, so it lives here where a test can
// reach it without React, a Supabase client or a query provider.
//
// No imports at all: the edge's own constants are MIRRORED below rather than
// imported, because src/ cannot reach into services/edge-functions/ and the
// Deno tree cannot reach back. src/lib/__tests__/sourcing-cost-settings.test.ts
// reads scout-decision.ts and fails if either copy moves.

/** Mirrors the CHECK in migration 00770 (0..100000 cents, i.e. $0..$1000). */
export const MAX_SOURCING_COST_CENTS = 100000;

/**
 * Mirrors DEFAULT_SOURCING_*_CENTS in
 * services/edge-functions/src/lib/scout-decision.ts.
 *
 * Shown as the placeholder on each field, so a seller who leaves one blank can
 * see what blank buys them instead of reverse-engineering it from a ceiling.
 */
export const DEFAULT_SOURCING_COST_CENTS = {
  shipping: 830,
  supplies: 35,
  grading: 200,
} as const;

export type SourcingCostKey = keyof typeof DEFAULT_SOURCING_COST_CENTS;

/** The flipdesk_settings column each field writes (migration 00770). */
export const SOURCING_COST_COLUMNS: Record<SourcingCostKey, string> = {
  shipping: "sourcing_shipping_cost_cents",
  supplies: "sourcing_supplies_cost_cents",
  grading: "sourcing_grading_cost_cents",
};

export interface SourcingCostField {
  key: SourcingCostKey;
  column: string;
  inputId: string;
  label: string;
  /** One line under the field, in the seller's terms rather than ours. */
  help: string;
}

/**
 * THREE FIELDS, NOT ONE OVERHEAD BOX, for the reason migration 00770 gives:
 * a seller adjusts postage when they change service, supplies when they buy
 * mailers in bulk, and the grading fee when they change plan. Folding them
 * together would make each of those edits a mental subtraction first.
 */
export const SOURCING_COST_FIELDS: readonly SourcingCostField[] = [
  {
    key: "shipping",
    column: SOURCING_COST_COLUMNS.shipping,
    inputId: "sourcing-cost-shipping",
    label: "Postage",
    help: "What you expect to pay to post one garment.",
  },
  {
    key: "supplies",
    column: SOURCING_COST_COLUMNS.supplies,
    inputId: "sourcing-cost-supplies",
    label: "Packaging",
    help: "Mailer, tape and label for one parcel.",
  },
  {
    key: "grading",
    column: SOURCING_COST_COLUMNS.grading,
    inputId: "sourcing-cost-grading",
    label: "Grading",
    help: "One grade. Set it to 0 if you don't grade everything you source.",
  },
];

/** Cents into the dollars string the input shows. Null (unset) is blank. */
export function centsToCostInput(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  return (cents / 100).toFixed(2);
}

export type ParsedCost =
  | { ok: true; cents: number | null }
  | { ok: false; error: string };

/**
 * A typed dollars string into the cents the column stores.
 *
 * BLANK IS null, NOT ZERO, and that distinction is the whole point of the
 * field. Null means "use the default"; zero means "I genuinely pay nothing for
 * this", which the edge honours literally. Coercing one into the other would
 * either silently raise every ceiling or silently override a seller who meant
 * what they typed.
 *
 * The bounds are the column's own CHECK, enforced here so a fat-fingered
 * "10000" comes back as a sentence rather than as a raw Postgres 23514.
 */
export function parseCostInput(raw: string): ParsedCost {
  const trimmed = raw.trim().replace(/^\$/, "").trim();
  if (trimmed === "") return { ok: true, cents: null };
  // Digits with at most one decimal point. Number.parseFloat would happily
  // read "1e9" and "8.30usd", and both would reach the database.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false, error: "Enter an amount in dollars, like 8.30." };
  }
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars)) {
    return { ok: false, error: "Enter an amount in dollars, like 8.30." };
  }
  const cents = Math.round(dollars * 100);
  if (cents < 0 || cents > MAX_SOURCING_COST_CENTS) {
    return {
      ok: false,
      error: `Enter an amount between $0 and $${MAX_SOURCING_COST_CENTS / 100}, or leave it blank.`,
    };
  }
  return { ok: true, cents };
}
