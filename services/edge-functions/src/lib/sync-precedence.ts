// Sync source-of-truth precedence rules — pure module, no network/env.
//
// Contract: SYNC_SOURCE_OF_TRUTH.md. Authority is per-listing, decided by
// listing_origin ('gradethread' | 'ebay').
//
// • listing_origin='ebay'      — eBay is the source of truth for listing
//   fields; inbound pull overwrites all EBAY_OWNED_LISTING_FIELDS.
// • listing_origin='gradethread' — GradeThread is the source of truth;
//   inbound pull only mirrors LISTING_READONLY_SIGNALS (sold/ended status).
// • GRADETHREAD_OWNED_ITEM_FIELDS — always owned by GradeThread regardless
//   of listing_origin; no eBay pull or CSV import may write them.
// • CSV import — fill-only: populates a field only when it is blank in the
//   existing row (null or empty string). Never overwrites a set value.

// ── Field ownership ────────────────────────────────────────────────────────

/**
 * Listing-table fields that belong to eBay.
 * For listing_origin='ebay': inbound pull overwrites all of these.
 * For listing_origin='gradethread': inbound pull must NOT write any of these
 * (they are editable in FlipDesk; eBay re-asserts on the next push).
 */
export const EBAY_OWNED_LISTING_FIELDS = [
  "listing_title",
  "listing_price",
  "listing_description",
  "listing_status",
  "is_active",
  "quantity",
  "listed_at",
  "platform_category_id",
  "platform_listing_id",
  "platform_offer_id",
  "listing_url",
] as const;

export type EbayOwnedListingField = (typeof EBAY_OWNED_LISTING_FIELDS)[number];

/**
 * eBay "item specifics" / aspects that map onto inventory_items catalog columns.
 * eBay supplies these on a pull; the catalog merge (ebay-catalog-merge.ts) fills
 * them only when the local cell is blank. Single source of truth for that list —
 * ebay-catalog-merge re-exports it as FILL_IF_BLANK_FIELDS.
 */
export const EBAY_OWNED_ITEM_SPECIFIC_FIELDS = [
  "brand",
  "size",
  "color",
  "style",
  "material",
] as const;

export type EbayOwnedItemSpecificField =
  (typeof EBAY_OWNED_ITEM_SPECIFIC_FIELDS)[number];

/**
 * eBay-managed condition fields on listings. eBay owns the item condition; the
 * GradeThread editor surfaces these read-only for eBay-originated listings.
 */
export const EBAY_OWNED_CONDITION_FIELDS = [
  "ebay_condition",
  "ebay_condition_description",
] as const;

/**
 * eBay business-policy references on listings (fulfillment / payment / return).
 * Configured on eBay; eBay-owned for precedence purposes.
 */
export const EBAY_OWNED_POLICY_FIELDS = [
  "shipping_policy_id",
  "payment_policy_id",
  "return_policy_id",
] as const;

/**
 * A strict subset of EBAY_OWNED_LISTING_FIELDS that represent observable facts
 * about the listing on eBay (active/ended/sold state). These flow in regardless
 * of listing_origin: GradeThread needs to know when eBay ends or marks a listing
 * as sold. Price, title, description, and quantity are NOT read-only signals.
 */
export const LISTING_READONLY_SIGNALS: ReadonlyArray<EbayOwnedListingField> = [
  "is_active",
  "listing_status",
] as const;

/**
 * inventory_items fields that GradeThread always owns.
 * No eBay pull (for any listing_origin) and no CSV import may write these.
 */
export const GRADETHREAD_OWNED_ITEM_FIELDS = [
  "grade_value",
  "condition_notes",
  "measurements",
  "acquired_price",
  "acquired_date",
  "sku",
  "source_id",
] as const;

export type GradethreadOwnedItemField =
  (typeof GRADETHREAD_OWNED_ITEM_FIELDS)[number];

// ── Ownership helpers + shared blank check ─────────────────────────────────

/**
 * The complete set of eBay-owned field names across listings + inventory_items:
 * the mirrored listing columns, the item-specifics/aspects, eBay condition, and
 * the business-policy references. This is the registry `isEbayOwned` consults.
 *
 * NOTE: this is a SUPERSET of EBAY_OWNED_LISTING_FIELDS. The narrower
 * EBAY_OWNED_LISTING_FIELDS / isEbayOwnedListingField drive the inbound-pull
 * mirror, the US-1080 edit guard, and the US-1083 Sheets carve-out (which must
 * only lock the mirrored listing columns, not fill-if-blank aspects). Use
 * isEbayOwned for "is this field eBay's to manage at all?" questions.
 */
export const EBAY_OWNED_FIELDS = [
  ...EBAY_OWNED_LISTING_FIELDS,
  ...EBAY_OWNED_ITEM_SPECIFIC_FIELDS,
  ...EBAY_OWNED_CONDITION_FIELDS,
  ...EBAY_OWNED_POLICY_FIELDS,
] as const;

/** Alias for GRADETHREAD_OWNED_ITEM_FIELDS — the fields GradeThread always owns. */
export const GRADETHREAD_OWNED_FIELDS = GRADETHREAD_OWNED_ITEM_FIELDS;

const EBAY_OWNED_FIELD_SET: ReadonlySet<string> = new Set(EBAY_OWNED_FIELDS);
const GRADETHREAD_OWNED_FIELD_SET: ReadonlySet<string> = new Set(
  GRADETHREAD_OWNED_ITEM_FIELDS,
);

/** Whether `field` is owned/managed by eBay (any of the eBay-owned registries). */
export function isEbayOwned(field: string): boolean {
  return EBAY_OWNED_FIELD_SET.has(field);
}

/** Whether `field` is always owned by GradeThread (never written by eBay/CSV). */
export function isGradeThreadOwned(field: string): boolean {
  return GRADETHREAD_OWNED_FIELD_SET.has(field);
}

/**
 * Shared blank test for fill-only / precedence logic. A value is blank ONLY when
 * it is null/undefined or a string that is empty (or whitespace-only). Anything
 * else counts as SET — notably `0`, `false`, an empty array `[]`, and any object
 * (e.g. a placeholder/JSON value). This intentionally differs from a truthiness
 * check so a legitimate `0` price or empty-but-present collection is preserved.
 */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

// ── Inbound eBay pull ──────────────────────────────────────────────────────

export type InboundEbayListing = Partial<
  Record<EbayOwnedListingField, string | number | boolean | null>
>;

export type ListingPullPatch = Partial<
  Record<EbayOwnedListingField, string | number | boolean | null>
>;

/**
 * Build the listings-table patch for one inbound eBay pull row.
 *
 * • listing_origin='ebay':       writes all EBAY_OWNED_LISTING_FIELDS present
 *                                in fromEbay (full mirror).
 * • listing_origin='gradethread': writes only LISTING_READONLY_SIGNALS
 *                                (sold/ended status); ignores price/title/etc.
 */
export function buildListingPullPatch(
  origin: "ebay" | "gradethread",
  fromEbay: InboundEbayListing,
): ListingPullPatch {
  const patch: ListingPullPatch = {};
  const allowed: ReadonlyArray<EbayOwnedListingField> =
    origin === "ebay" ? EBAY_OWNED_LISTING_FIELDS : LISTING_READONLY_SIGNALS;
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(fromEbay, field)) {
      (patch as Record<string, unknown>)[field] = fromEbay[field];
    }
  }
  return patch;
}

// ── CSV fill-only import ───────────────────────────────────────────────────

/**
 * Build the patch for a CSV import row merging onto an existing inventory_item.
 * Fill-only contract: a field is written only when the existing row has it blank
 * (null, undefined, or empty string). A populated field is NEVER overwritten.
 *
 * Incoming values that are themselves blank are always skipped.
 * GRADETHREAD_OWNED_ITEM_FIELDS are never included in the result.
 */
export function buildCsvFillPatch<T extends string>(
  existing: Partial<Record<T, unknown>>,
  incoming: Partial<Record<T, unknown>>,
): Partial<Record<T, unknown>> {
  const patch: Partial<Record<T, unknown>> = {};
  for (const [key, value] of Object.entries(incoming) as [T, unknown][]) {
    if (
      (GRADETHREAD_OWNED_ITEM_FIELDS as ReadonlyArray<string>).includes(key)
    ) {
      continue; // GradeThread-owned: never overwrite even if blank.
    }
    if (isBlank(existing[key]) && !isBlank(value)) {
      patch[key] = value;
    }
  }
  return patch;
}

// ── US-1080 server guard ───────────────────────────────────────────────────

export interface EditValidationResult {
  /** Fields that the caller IS allowed to write. */
  allowed: EbayOwnedListingField[];
  /** Fields that are locked because the listing is eBay-originated. */
  locked: EbayOwnedListingField[];
  /** Fields not recognised as eBay-owned (always allowed through). */
  other: string[];
}

/**
 * Validate an attempted edit to a listing's fields against the provenance
 * model (US-1080). For eBay-originated listings (listing_origin='ebay'),
 * EBAY_OWNED_LISTING_FIELDS are locked — the server must reject writes to
 * them. For GradeThread-originated listings, all fields are editable.
 *
 * Returns three buckets: locked (rejected), allowed (eBay-owned but
 * permitted — always empty for 'ebay' origin), and other (non-eBay-owned
 * fields, always permitted).
 */
export function validateEbayOriginEdit(
  origin: "ebay" | "gradethread",
  requestedFields: string[],
): EditValidationResult {
  const ebayOwned = new Set<string>(EBAY_OWNED_LISTING_FIELDS);
  const locked: EbayOwnedListingField[] = [];
  const allowed: EbayOwnedListingField[] = [];
  const other: string[] = [];

  for (const field of requestedFields) {
    if (ebayOwned.has(field)) {
      if (origin === "ebay") {
        locked.push(field as EbayOwnedListingField);
      } else {
        allowed.push(field as EbayOwnedListingField);
      }
    } else {
      other.push(field);
    }
  }
  return { locked, allowed, other };
}

// ── Listing provenance (US-1077 marker / US-1083 Sheets guard) ──────────────

const EBAY_OWNED_LISTING_FIELD_SET: ReadonlySet<string> = new Set(
  EBAY_OWNED_LISTING_FIELDS,
);

/** Whether `field` is an eBay-owned listing column (see EBAY_OWNED_LISTING_FIELDS). */
export function isEbayOwnedListingField(field: string): boolean {
  return EBAY_OWNED_LISTING_FIELD_SET.has(field);
}

/**
 * Signals used to decide a listing's provenance. Once US-1077 persists the
 * `listing_origin` column, pass it as `listing_origin` and it wins outright;
 * until then origin is derived from the same existing signals US-1077 backfills
 * from, so this helper is forward-compatible (the derived value equals the
 * future stored value).
 */
export interface ListingOriginSignals {
  /** Persisted marker once US-1077 lands it ('ebay' | 'gradethread'). */
  listing_origin?: string | null;
  platform?: string | null;
  /** eBay listing id — present on listings that exist on eBay. */
  platform_listing_id?: string | null;
  /** FlipDesk publish batch — set only when WE created the listing. */
  batch_id?: string | null;
  /** Set only when FlipDesk pushed the listing up to eBay. */
  synced_to_ebay_at?: string | null;
}

/**
 * Decide whether a listing is eBay-originated or GradeThread-originated.
 *
 * Provenance (SYNC_SOURCE_OF_TRUTH.md): GT-originated = published from FlipDesk
 * (`batch_id` / `synced_to_ebay_at` set); eBay-originated = imported from eBay
 * (lives on eBay — `platform_listing_id` set — but we never published it).
 * The default is 'gradethread' so an ambiguous listing keeps full bidirectional
 * Sheets behavior rather than being wrongly locked.
 */
export function deriveListingOrigin(
  s: ListingOriginSignals,
): "ebay" | "gradethread" {
  if (s.listing_origin === "ebay" || s.listing_origin === "gradethread") {
    return s.listing_origin;
  }
  if (s.batch_id || s.synced_to_ebay_at) return "gradethread";
  if ((s.platform ?? "").toLowerCase() === "ebay" && s.platform_listing_id) {
    return "ebay";
  }
  return "gradethread";
}

/**
 * US-1083 — the Google Sheets carve-out. Sheets stays bidirectional EXCEPT a
 * sheet edit to an eBay-OWNED field on an eBay-originated (locked) listing must
 * NOT be applied: eBay is source of truth and re-asserts on its next sync.
 * Field-scoped — non-eBay-owned cells on the same listing still sync.
 *
 * Returns true when the divergent sheet cell should be discarded (rewritten
 * from the DB) and reported to the user as a skipped item.
 */
export function isSheetEditLockedByEbay(
  origin: "ebay" | "gradethread",
  field: string,
  sheetValue: string,
  dbValue: string,
): boolean {
  return (
    origin === "ebay" &&
    isEbayOwnedListingField(field) &&
    sheetValue !== "" &&
    sheetValue !== dbValue
  );
}
