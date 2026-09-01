// The platform-agnostic listing lifecycle (US-2166).
//
// These helpers used to live inside routes/flipdesk-listings.ts while the
// eBay-namespaced routes in flipdesk-ebay.ts carried their OWN copy of the same
// logic. Two implementations of a money-touching operation is how a fix lands in
// one and not the other — and they had already drifted: the agnostic price path
// reports honestly when the marketplace accepted a change our copy then failed
// to save, and the eBay one silently ignored that write error.
//
// So the core lives here, in lib, and BOTH route files call it. lib has no
// import back into routes, which is what keeps the eBay-namespaced routes able
// to use it: flipdesk-ebay.ts already sits in the
// flipdesk-ebay -> adapters/index -> adapters/ebay -> flipdesk-ebay cycle
// (flipdesk-ebay.ts imports resolveAdapter), and every binding here is consumed
// inside a request handler rather than at module evaluation, so routing through
// this module adds no new cycle class.
//
// The shipped-client rule still holds: /api/flipdesk/ebay/listings/* must keep
// answering, because iOS, Android and the browser extension call those paths and
// cannot be redeployed. They keep answering — they just stop keeping a second
// copy of the logic.
//
// SECURITY (US-268): loadOwnedListing filters on inventory_items.user_id. An id
// from a request never reaches a write without that check.

import { supabaseAdmin } from "./supabase.ts";
import { isExtensionRevisePlatform, queueReviseForListing } from "./pending-revises.ts";
import { ebayOriginWriteLock } from "./sync-precedence.ts";
import {
  isNoEbayConnectionError,
  isOfferAlreadyEndedError,
  updateOfferPrice,
} from "./ebay-client.ts";
import { resolveAdapter } from "./marketplace-adapters/index.ts";
import { resyncItemListedStatus } from "./active-listings.ts";
import { delistMethodFor } from "./cross-listing-sale.ts";

export interface OwnedListingRow {
  id: string;
  inventory_item_id: string | null;
  platform: string | null;
  listing_price: number | null;
  listing_status: string | null;
  listing_url: string | null;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  listing_origin: string | null;
  batch_id: string | null;
  synced_to_ebay_at: string | null;
  marketplace_connection_id: string | null;
  // US-2166: an eBay multi-variation listing publishes as an inventory_item_group
  // and carries NO platform_offer_id, so it can only be withdrawn by its group
  // key. Without these two the adapter answered "no offer id to withdraw" and
  // left the listing LIVE — a regression this route introduced when US-2162
  // pointed the listings page at it.
  variations: unknown;
  item_sku: string | null;
}

// Owner-verified listing load (US-268 rule 2 — ownership via the parent item).
// Selects the columns the agnostic lifecycle needs, INCLUDING `platform`, whose
// absence from the eBay loader is what let the origin lock be computed against a
// hardcoded "ebay" for every row.
export async function loadOwnedListing(
  listingId: string,
  ownerId: string,
): Promise<OwnedListingRow | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform, listing_price, listing_status, listing_url, " +
        "platform_offer_id, platform_listing_id, listing_origin, batch_id, " +
        "synced_to_ebay_at, marketplace_connection_id, variations, inventory_sku, " +
        "inventory_items!inner(user_id, sku)",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as OwnedListingRow & {
    inventory_sku: string | null;
    inventory_items: { user_id: string; sku: string | null };
  };
  if (row.inventory_items.user_id !== ownerId) return null;
  // US-1999: the PINNED sku the listing actually went live under wins over the
  // item's current one. eBay created the inventory_item_group under the pinned
  // value, so a seller who has since renamed the SKU would otherwise have the
  // group withdraw aimed at a key that does not exist — eBay 404s, the caller
  // reads that as "already ended", and the variation listing stays live while
  // FlipDesk reports it ended. The eBay-namespaced end route has read the pinned
  // value since US-1999; this loader, which now serves the same operation, did
  // not. Falls back to the item's sku for rows published before the pin existed.
  return { ...row, item_sku: row.inventory_sku ?? row.inventory_items.sku };
}

// Was this row ever actually published to its marketplace? This is orthogonal to
// is_active: a row can sit in 'draft' status (is_active=false since US-2176) yet
// have reached the marketplace, and that published-draft must still count as
// live. So liveness is status + this upstream check, not the is_active mirror.
export function wasPublishedUpstream(row: OwnedListingRow): boolean {
  return Boolean(
    row.platform_offer_id || row.platform_listing_id || row.synced_to_ebay_at,
  );
}

/**
 * Is this listing LIVE — something a buyer could still purchase?
 *
 * US-2657: this rule used to live inline in the delete guard, which meant the
 * app carried three different answers to one question. `itemHasActiveListing`
 * asks `is_active`, the composer asks `listing_status === "active" && an offer
 * id`, and this asked a third thing — so a row could read DRAFT on the screen and
 * LIVE to the server, and a seller deleting a duplicate was refused with no way
 * to see what the server had seen. This is the careful version, and it is now the
 * shared one.
 *
 * The published-DRAFT case is why it cannot just read `is_active`: a row still in
 * 'draft' status that nonetheless reached the marketplace is live while
 * is_active is false, so is_active alone under-reports it.
 */
export function isListingLive(row: {
  listing_status: string | null;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  synced_to_ebay_at: string | null;
}): boolean {
  return liveBlockReason(row) !== null;
}

/**
 * WHY a listing counts as live, or null when it doesn't.
 *
 * Returned to the client so a refusal can name its own cause. "This item has a
 * live listing" with nothing else is unactionable when the screen says draft —
 * the seller has no way to tell a genuinely live listing from a stale row, and
 * both are things they hit in the same week.
 */
export function liveBlockReason(row: {
  listing_status: string | null;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  synced_to_ebay_at: string | null;
}): "active_status" | "published_draft" | null {
  const status = row.listing_status ?? "";
  // Terminal states never block.
  if (status === "ended" || status === "sold") return null;
  // An active lifecycle status is live (covers eBay + manually-marked-listed).
  if (status === "active" || status === "relisted") return "active_status";
  // Any other status (e.g. 'draft'): only live if it actually reached a
  // marketplace — a real offer/listing id or a completed eBay sync.
  if (
    row.platform_offer_id || row.platform_listing_id || row.synced_to_ebay_at
  ) {
    return "published_draft";
  }
  return null;
}

// The 409 an eBay-ORIGINATED listing gets for any write to a field eBay owns
// (US-1976). Computed against the row's real platform, so a Shopify row is never
// mislabelled as eBay-owned.
export function originLockResponse(
  row: OwnedListingRow,
  fields: string[],
): { locked: true; body: Record<string, unknown> } | { locked: false } {
  const lock = ebayOriginWriteLock(
    {
      listing_origin: row.listing_origin,
      platform: row.platform,
      platform_listing_id: row.platform_listing_id,
      batch_id: row.batch_id,
      synced_to_ebay_at: row.synced_to_ebay_at,
    },
    fields,
  );
  if (!lock.locked) return { locked: false };
  return {
    locked: true,
    body: {
      error:
        "This listing was created on eBay, so eBay owns it. Change it on eBay — " +
        "edits here would be overwritten on the next sync.",
      locked_fields: lock.lockedFields,
    },
  };
}

/** Human marketplace name for an error message. */
export function platformName(platform: string | null): string {
  return platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : "This marketplace";
}

// Status codes the lifecycle handlers can return, as a literal union (the
// LoadListingResult convention in flipdesk-ebay.ts) so no handler has to cast a
// bare number into c.json's status parameter.
export type LifecycleStatus = 409 | 500 | 501 | 502;
export interface LifecycleFailure {
  status: LifecycleStatus;
  error: string;
}

// Collapse an adapter's numeric status into the codes this surface returns.
// Explicit rather than a cast: an adapter is free to hand back anything, and
// asserting `as 502` over a 400 would put a lie in the type system.
export function adapterStatus(status: number): 409 | 501 | 502 {
  if (status === 501) return 501; // capability not wired for this platform
  if (status === 409) return 409; // conflicting state (not connected, no id)
  return 502; // the marketplace refused
}

// Push a new price to the row's marketplace. Returns null on success, or the
// error to surface.
//
// ORDERING (this is the whole correctness property): callers push FIRST and
// write listings.listing_price only after this returns null. There is therefore
// no window in which the local price is ahead of the marketplace, and no
// rollback that could itself fail and strand the divergence.
//
// That ordering is safe because every adapter takes the price from its INPUT
// when it is > 0 (shopify.ts / etsy.ts / depop.ts all read
// `price > 0 ? price : row.listing_price`) and this function is only ever called
// with a validated positive price — so none of them read the not-yet-written
// column. If an adapter ever starts sourcing the price from the row, this
// ordering has to be revisited.
export async function pushPriceUpstream(
  ownerId: string,
  row: OwnedListingRow,
  price: number,
): Promise<LifecycleFailure | null> {
  if (row.platform === "ebay") {
    if (!row.platform_offer_id) {
      return {
        status: 409,
        error:
          "This listing has no eBay offer id. Sync from eBay or republish to enable price updates.",
      };
    }
    try {
      // US-1507: price the offer via the listing's own connection (null → primary).
      await updateOfferPrice(
        ownerId,
        row.platform_offer_id,
        price,
        "USD",
        row.marketplace_connection_id ?? undefined,
      );
      return null;
    } catch (err) {
      console.error("[flipdesk-listings] updateOfferPrice failed:", err);
      return { status: 502, error: "eBay rejected the price update." };
    }
  }

  const adapter = resolveAdapter(row.platform);
  if (!adapter) {
    return {
      status: 501,
      error: `${platformName(row.platform)} isn't a supported marketplace.`,
    };
  }
  if (!row.inventory_item_id) {
    return { status: 409, error: "This listing has no linked inventory item." };
  }
  try {
    const res = await adapter.updateListing({
      ownerId,
      inventoryItemId: row.inventory_item_id,
      listingRowId: row.id,
      price,
    });
    if (res.ok) return null;
    return { status: adapterStatus(res.status), error: res.error };
  } catch (err) {
    // An adapter that throws rather than returning a typed failure must not be
    // mistaken for success — that is exactly how the local price used to drift.
    console.error("[flipdesk-listings] adapter updateListing threw:", err);
    return {
      status: 502,
      error: `${platformName(row.platform)} rejected the price update.`,
    };
  }
}


export async function endLocally(
  listingId: string,
  inventoryItemId: string | null,
  ownerId: string,
): Promise<void> {
  const { error: lErr } = await supabaseAdmin
    .from("listings")
    .update({ listing_status: "ended", is_active: false })
    .eq("id", listingId);
  if (lErr) {
    console.error("[flipdesk-listings] end: listing update failed:", lErr.message);
    // The row is still marked live, so the resync below would (correctly) keep
    // the item 'listed'. Bail rather than imply the end reconciled cleanly.
    return;
  }
  await resyncItemListedStatus(inventoryItemId, ownerId);
}

/**
 * Reprice one listing on its own marketplace.
 *
 * ORDERING is the correctness property: push FIRST, write local only after. A
 * failure returns without ever having touched the local row, so the seller's
 * price keeps matching the live listing — no rollback to get wrong, and no
 * window where the two disagree.
 *
 * `pushed:false` with ok:true means one specific thing: nothing was ever
 * published, so there was no marketplace to push to. It is the ONE legitimate
 * local-only write, and it is local-only because nothing is live — never because
 * a remote call failed.
 */
export type ApplyPriceResult =
  // US-9202: `queued` is the third honest answer. pushed:true means the
  // marketplace has the price; pushed:false means there was nothing live to
  // push to; queued:true means the listing IS live, on a channel only the
  // seller's browser can write to, and the desktop extension will apply it.
  | { ok: true; price: number; pushed: boolean; queued?: boolean }
  // One failure arm, not several: LifecycleStatus already includes 409, so
  // splitting the lock case into its own arm made `status === 409` fail to
  // narrow and hid lockedFields from every caller.
  | {
    ok: false;
    status: LifecycleStatus | 404;
    error: string;
    /** Present only on the eBay-origin lock (US-1976). */
    lockedFields?: string[];
  };

export async function applyListingPrice(
  ownerId: string,
  listingId: string,
  price: number,
): Promise<ApplyPriceResult> {
  const row = await loadOwnedListing(listingId, ownerId);
  if (!row) return { ok: false, status: 404, error: "Listing not found." };

  const lock = originLockResponse(row, ["listing_price"]);
  if (lock.locked) {
    return {
      ok: false,
      status: 409,
      error: String(lock.body.error),
      lockedFields: lock.body.locked_fields as string[] | undefined,
    };
  }

  // US-9202: an extension channel has no write API, so the push above would
  // answer 501 and the seller would be told the marketplace refused. The local
  // row takes the price now and the listing is marked stale on that channel;
  // the seller's desktop extension re-applies it in their own tab and confirms.
  // A draft there (never seen live) is a local write like any other draft.
  if (isExtensionRevisePlatform(row.platform)) {
    const { error } = await supabaseAdmin
      .from("listings")
      .update({ listing_price: price })
      .eq("id", listingId)
      .eq("user_id", ownerId);
    if (error) {
      return { ok: false, status: 500, error: "Could not save the price." };
    }
    const live = row.listing_status === "active" && !!row.listing_url;
    const queued = live ? await queueReviseForListing(row, ["price"], "edit") : false;
    if (row.inventory_item_id) {
      await supabaseAdmin
        .from("inventory_items")
        .update({ target_price: price })
        .eq("id", row.inventory_item_id)
        .eq("user_id", ownerId);
    }
    return { ok: true, price, pushed: false, queued };
  }

  if (!wasPublishedUpstream(row)) {
    const { error } = await supabaseAdmin
      .from("listings")
      .update({ listing_price: price })
      .eq("id", listingId)
      .eq("user_id", ownerId);
    if (error) {
      return { ok: false, status: 500, error: "Could not save the price." };
    }
    return { ok: true, price, pushed: false };
  }

  const failure = await pushPriceUpstream(ownerId, row, price);
  if (failure) return { ok: false, status: failure.status, error: failure.error };

  const { error: writeErr } = await supabaseAdmin
    .from("listings")
    .update({ listing_price: price })
    .eq("id", listingId)
    .eq("user_id", ownerId);
  if (writeErr) {
    // The marketplace HAS the new price; only our copy is stale. Report it
    // rather than claiming success, but say which way round the mismatch is —
    // "retry" would otherwise re-push a price that is already live.
    console.error(
      "[listing-lifecycle] price pushed but local write failed:",
      writeErr.message,
    );
    return {
      ok: false,
      status: 500,
      error:
        "The new price is live on the marketplace, but we couldn't update our copy. " +
        "It'll correct on the next sync.",
    };
  }

  // US-1504: mirror the live price onto the item's target_price so the canvas
  // "price not pushed" badge doesn't invert after a reprice.
  if (row.inventory_item_id) {
    await supabaseAdmin
      .from("inventory_items")
      .update({ target_price: price })
      .eq("id", row.inventory_item_id)
      .eq("user_id", ownerId);
  }

  return { ok: true, price, pushed: true };
}

/**
 * Ending a listing, as a result rather than a response (US-9129).
 *
 * The contract that matters, and the reason this is not a one-liner: the local
 * row is marked ended ONLY when the listing is genuinely not live any more. A
 * failed delist returns an error and leaves the row active, because telling a
 * seller an item is ended while buyers can still buy it is worse than telling
 * them the end failed.
 *
 * Moved out of POST /api/flipdesk/listings/:id/end so the connector's end tool
 * calls the same path instead of writing a second one. The status/body pair is
 * exactly what that route returned, so its responses are unchanged.
 */
export interface EndListingOutcome {
  status: number;
  body: Record<string, unknown>;
}

const json = (
  body: Record<string, unknown>,
  status = 200,
): EndListingOutcome => ({ status, body });

export async function endOwnedListing(
  ownerId: string,
  listingId: string,
): Promise<EndListingOutcome> {
  const row = await loadOwnedListing(listingId, ownerId);
  if (!row) return json({ error: "Listing not found." }, 404);

  if (row.listing_status === "ended" || row.listing_status === "sold") {
    return json({ ok: true, listing_id: listingId, already_ended: true });
  }

  // Nothing was ever published — end it locally and move the item back to a
  // draft so it can be relisted.
  if (!wasPublishedUpstream(row)) {
    await endLocally(listingId, row.inventory_item_id, ownerId);
    return json({ ok: true, listing_id: listingId, ended_upstream: false });
  }

  // US-2162 (AC3): dispatch on the same planner autoEndCrossListings uses, so
  // the manual End and the sale-triggered auto-end can't disagree about how a
  // marketplace is delisted. Before this, a Poshmark/Mercari/Grailed listing —
  // which has no server-side delist API — got a flat 501 here while the auto-end
  // path queued it for the Lister extension. Same listing, same marketplace, two
  // different answers, and the manual one left the seller with nothing to do.
  const method = delistMethodFor(row.platform ?? "");

  if (method === "extension") {
    // No API exists for these. Stamp delist_requested_at so the extension ends
    // it in the seller's own tab next time they're in the app (the writeback
    // clears the stamp), exactly as the auto-end path does.
    const { error: stampErr } = await supabaseAdmin
      .from("listings")
      .update({ delist_requested_at: new Date().toISOString() })
      .eq("id", listingId)
      .eq("user_id", ownerId); // US-268
    if (stampErr) {
      console.error(
        "[flipdesk-listings] delist queue stamp failed:",
        stampErr.message,
      );
      return json(
        {
          error:
            `We couldn't queue this ${platformName(row.platform)} listing to be ended. ` +
            "It's still live — try again in a moment.",
          code: "delist_failed",
        },
        502,
      );
    }
    await endLocally(listingId, row.inventory_item_id, ownerId);
    // `ended_upstream: false` is the truth: it is NOT yet ended on the
    // marketplace. The queued flag is what tells the client to say so.
    return json({
      ok: true,
      listing_id: listingId,
      ended_upstream: false,
      queued: true,
      note:
        `${platformName(row.platform)} has no end-listing API, so the GradeThread ` +
        "Lister extension will end it in your browser next time you open FlipDesk. " +
        "It stays live until then.",
    });
  }

  const adapter = method === "unsupported"
    ? null
    : resolveAdapter(row.platform ?? "");
  if (!adapter) {
    return json(
      {
        error:
          `${platformName(row.platform)} listings can't be ended from GradeThread. ` +
          "End it on that marketplace, then mark it ended here.",
        code: "unsupported_platform",
      },
      501,
    );
  }

  try {
    const res = await adapter.delist({
      ownerId,
      listingRowId: row.id,
      platformOfferId: row.platform_offer_id,
      platformListingId: row.platform_listing_id,
      // US-2166: without these an eBay variation listing cannot be ended.
      variations: row.variations,
      itemSku: row.item_sku,
      // US-1507: end through the account that published it.
      connectionId: row.marketplace_connection_id,
    });
    if (!res.ok) {
      return json(
        { error: res.error, code: "delist_failed" },
        adapterStatus(res.status),
      );
    }
  } catch (err) {
    // eBay's adapter delist throws rather than returning a typed failure, so the
    // same three-way classification the manual eBay end route uses (US-1506 /
    // US-1978) applies here.
    if (isOfferAlreadyEndedError(err)) {
      // Already not live upstream — reconciling locally is correct, not a lie.
      await endLocally(listingId, row.inventory_item_id, ownerId);
      return json({
        ok: true,
        listing_id: listingId,
        ended_upstream: false,
        note: "The listing was already not live on the marketplace.",
      });
    }
    if (isNoEbayConnectionError(err)) {
      return json(
        {
          error:
            "Your eBay account isn't connected, so we couldn't end this live listing " +
            "on eBay. Reconnect eBay in Marketplaces, then end it again.",
          code: "not_connected",
        },
        409,
      );
    }
    console.error("[flipdesk-listings] delist threw:", err);
    return json(
      {
        error:
          `${platformName(row.platform)} couldn't end this listing just now. ` +
          "It's still live — try again in a moment.",
        code: "delist_failed",
      },
      502,
    );
  }

  await endLocally(listingId, row.inventory_item_id, ownerId);
  return json({ ok: true, listing_id: listingId, ended_upstream: true });
}
