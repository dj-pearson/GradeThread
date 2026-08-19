// US-9116: the seam between a lib and the eBay publish path.
//
// publishItemForOwner and assemblePublishContext live in
// routes/flipdesk-ebay.ts, an 11,344-line module with about 2,500 lines of
// publish-specific helpers around them. Moving those is US-9130's job and it is
// judgement-heavy work on the one path that puts a seller's listings live.
//
// A connector tool cannot import a route, so the route REGISTERS its two
// functions here at module load and this port hands them out. Same pattern as
// lib/autolister-enqueue.ts, for the same reason: the direction of the import
// is the thing that matters, not where the code sits today.
//
// The route adapts its own PublishContext into the narrow shape below, rather
// than this file importing that type. Keeping the mapping next to the context
// definition means a new blocker or a renamed field is a compile error there,
// where someone is already looking.
//
// ⚠ WHEN US-9130 LANDS, this file should become a plain re-export. Leaving a
// registration seam in place once the functions are importable would be
// indirection with nothing behind it.

/** Exactly what the connector shows a seller before it publishes. */
export interface PublishPreviewData {
  /** False when the publish would be refused right now. */
  ready: boolean;
  /** Why it would be refused. Empty when ready. */
  blockers: string[];
  /** Things worth saying that do NOT stop the publish. */
  warnings: string[];
  title: string;
  /** Dollars. Null when nothing resolved a price, which is itself a blocker. */
  price: number | null;
  quantity: number;
  categoryId: string | null;
  /** eBay refuses a publish with no business policies; this says whether they resolved. */
  policiesReady: boolean;
  photoCount: number;
  /** eBay's own condition enum, e.g. USED_EXCELLENT. */
  condition: string | null;
}

export type PublishItemOutcome =
  | {
    ok: true;
    listing_id: string;
    listing_url: string;
    offer_id: string;
    sku: string;
    /** The listing IS live but the local sync did not land. Success, not failure. */
    sync_pending?: boolean;
  }
  | { ok: false; status: number; body: Record<string, unknown> };

export type PreviewFn = (ownerId: string, itemId: string) => Promise<PublishPreviewData>;
export type PublishFn = (
  ownerId: string,
  itemId: string,
  opts?: { relist?: boolean },
) => Promise<PublishItemOutcome>;

interface Publisher {
  preview: PreviewFn;
  publish: PublishFn;
}

let publisher: Publisher | null = null;

/** Called by routes/flipdesk-ebay.ts at module load. */
export function registerEbayPublisher(impl: Publisher): void {
  publisher = impl;
}

/**
 * The registered publisher, or null.
 *
 * Null is a REAL state a caller must handle, not an assertion to skip: it means
 * the route module was never imported, and publishing while it is null would
 * quietly do nothing. A tool that reads null must say the publish surface is
 * unavailable rather than report success.
 */
export function ebayPublisher(): Publisher | null {
  return publisher;
}

export function hasEbayPublisher(): boolean {
  return publisher !== null;
}
