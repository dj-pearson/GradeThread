// US-1968 — bring a seller's EXISTING eBay (Trading-created) listings under
// GradeThread management via the Inventory API's bulk_migrate_listing.
//
// Why this exists: a Trading-created listing imports read-only
// (getAllActiveEbaySelling) and relist refuses eBay-origin rows, so an
// established reseller's live catalog could be viewed but never revised,
// repriced, promoted or withdrawn through GradeThread. That is most customers'
// day one.
//
// ⚠ THE THING THAT MAKES THIS SAFE (and that blocked this story until US-1999):
// bulk_migrate_listing returns eBay's OWN sku per listing — eBay derives it
// from the listing's Custom Label or generates one, so it is NOT the SKU
// GradeThread would have derived. Every subsequent Inventory call keys off that
// sku. Before listings.inventory_sku existed (00477) there was nowhere to put
// it, so a "successful" migration would have flipped the row to GT-managed
// while every revise/reprice/withdraw targeted an inventory item that does not
// exist — AND the origin flip stops the inbound pull from mirroring the row
// (SYNC_SOURCE_OF_TRUTH: EBAY_OWNED_LISTING_FIELDS are only overwritten while
// origin='ebay'). The row would go stale AND be unmanageable: strictly worse
// than the read-only mirror it replaced. So: NEVER flip origin without
// persisting the returned sku in the same write.
//
// This module is PURE (no network, no supabase) so the response contract can be
// tested without an eBay account — see ebay-migrate_test.ts.

/** eBay caps bulk_migrate_listing at 5 listings per call. */
export const MIGRATE_BATCH_MAX = 5;

/** One entry of eBay's `responses[]`. Shape per the Inventory API docs. */
export interface RawMigrateResponse {
  statusCode?: number;
  listingId?: string;
  marketplaceId?: string;
  inventoryItems?: Array<{ sku?: string; offerId?: string }>;
  errors?: Array<{ errorId?: number; message?: string; longMessage?: string }>;
  warnings?: Array<{ errorId?: number; message?: string; longMessage?: string }>;
}

export interface MigrateOutcome {
  /** eBay's listing id (the Trading ItemID) this outcome is for. */
  listingId: string;
  ok: boolean;
  /** eBay's OWN sku — authoritative, store it verbatim. Null when !ok. */
  sku: string | null;
  offerId: string | null;
  /**
   * Why it failed, in eBay's words. AC3: ineligible listings are REPORTED with
   * the eBay reason, never silently dropped — "ineligible" here covers real
   * product limits (multi-variation listings, unsupported categories) that a
   * seller can only act on if they are told which listing and why.
   */
  reason: string | null;
}

/** Prefer the longer, more actionable text eBay sends. */
function messageOf(
  e: { message?: string; longMessage?: string } | undefined,
): string | null {
  if (!e) return null;
  const m = (e.longMessage ?? e.message ?? "").trim();
  return m || null;
}

/**
 * Normalize eBay's per-listing response array into one outcome per listing.
 *
 * Deliberately does NOT throw on a partial failure: bulk_migrate_listing is
 * per-listing, so a batch of 5 can be 3 successes and 2 ineligible, and
 * treating that as a batch error would discard the successes.
 */
export function parseMigrateResponse(raw: unknown): MigrateOutcome[] {
  const responses = (raw as { responses?: RawMigrateResponse[] } | null)
    ?.responses;
  if (!Array.isArray(responses)) return [];

  const out: MigrateOutcome[] = [];
  for (const r of responses) {
    const listingId = typeof r?.listingId === "string" ? r.listingId : "";
    if (!listingId) continue; // nothing to key an update on

    const item = r.inventoryItems?.[0];
    const sku = typeof item?.sku === "string" && item.sku.trim()
      ? item.sku.trim()
      : null;
    const offerId = typeof item?.offerId === "string" && item.offerId.trim()
      ? item.offerId.trim()
      : null;

    const status = typeof r.statusCode === "number" ? r.statusCode : 0;
    const errorText = messageOf(r.errors?.[0]);

    // A 2xx WITHOUT a sku is treated as a failure, not a success. This is the
    // load-bearing case: flipping origin on a row we cannot address later is
    // the exact "managed but unmanageable" state described in the header.
    const ok = status >= 200 && status < 300 && !!sku;

    out.push({
      listingId,
      ok,
      sku: ok ? sku : null,
      offerId: ok ? offerId : null,
      reason: ok
        ? null
        : errorText ??
          (status >= 200 && status < 300 && !sku
            ? "eBay reported success but returned no SKU, so the listing cannot be managed. It was left as a read-only mirror."
            : `eBay declined the migration (status ${status || "unknown"}).`),
    });
  }
  return out;
}

/** Split ids into eBay-legal batches (max 5). */
export function chunkForMigrate<T>(
  items: T[],
  size: number = MIGRATE_BATCH_MAX,
): T[][] {
  const n = Math.max(1, Math.min(size, MIGRATE_BATCH_MAX));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
