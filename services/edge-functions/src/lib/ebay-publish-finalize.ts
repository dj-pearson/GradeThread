// eBay publish atomicity (US-783).
//
// publishOrAdoptOffer makes the listing LIVE on eBay. The local DB writes that
// follow (the `listings` row + inventory_items.status) come AFTER that
// irreversible side effect. Previously a failure on those writes fell into the
// publish catch and returned a "Publish failed" error — telling the seller their
// listing failed when it is actually live, and leaving an orphaned eBay listing.
//
// finalizePublishedListing closes that gap: it retries the local write a few
// times, and on persistent failure records a reconciliation marker (the
// orders/listings pull-sync adopts the orphaned eBay listing by SKU and creates
// the missing `listings` row) and returns sync_pending — so the caller returns a
// 200-level "your listing is live and will sync shortly", never a publish error.
//
// Pure + injectable (persist / recordReconcile) so the post-publish failure path
// is unit-testable without eBay or a DB.

export interface PublishFinalizeDeps {
  // The local writes (listings upsert + inventory_items status). Throws on a DB error.
  persist: () => Promise<void>;
  // Best-effort reconciliation marker, only invoked once retries are exhausted.
  recordReconcile: () => Promise<void>;
  // Retries of `persist` after the first attempt (default 2 → 3 attempts total).
  maxRetries?: number;
}

export interface PublishFinalizeResult {
  // true → the local write didn't land; the listing is live and a reconcile
  // marker was recorded for the pull-sync to adopt. The caller returns success
  // with sync_pending so the seller isn't told a live listing failed.
  syncPending: boolean;
  // How many persist attempts were made (for logging/metrics).
  attempts: number;
}

export async function finalizePublishedListing(
  deps: PublishFinalizeDeps,
): Promise<PublishFinalizeResult> {
  const max = deps.maxRetries ?? 2;
  for (let attempt = 1; attempt <= max + 1; attempt++) {
    try {
      await deps.persist();
      return { syncPending: false, attempts: attempt };
    } catch (_err) {
      if (attempt === max + 1) {
        // Out of retries — the listing is live but unsynced. Record the marker
        // (best-effort; the pull-sync would still adopt the orphan even without
        // it) and tell the caller to report success-with-sync-pending.
        await deps.recordReconcile().catch(() => {});
        return { syncPending: true, attempts: attempt };
      }
      // else retry
    }
  }
  // Unreachable, but keeps the type total.
  return { syncPending: true, attempts: max + 1 };
}
