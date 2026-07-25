import { supabaseAdmin } from "./supabase.ts";
import {
  isNoEbayConnectionError,
  isOfferAlreadyEndedError,
  withdrawOffer,
} from "./ebay-client.ts";
import { getShopifyConnection } from "./shopify-client.ts";
import { deleteProductGraphql } from "./shopify-graphql.ts";
import { getDepopConnection } from "./depop-client.ts";
import { deleteDepopProduct } from "./depop-api.ts";
import { getEtsyConnection, isEtsyEnabled } from "./etsy-client.ts";
import { setEtsyListingState } from "./etsy-api.ts";
import { notifyUser } from "./notify.ts";
import {
  delistMethodFor,
  planCrossListingSale,
} from "./cross-listing-sale.ts";

// Auto-end of cross-listed siblings (US-149 + US-599 + US-1290). When one listing
// in a cross-listing group (rows sharing listings.draft_id) sells, end the others
// so the same garment isn't sold twice. Gated by the per-user
// flipdesk_settings.auto_end_cross_listings toggle (absent row = enabled).
//
// US-1290: a sibling that is ALREADY 'sold' means the same physical item sold on
// more than one channel (a simultaneous sale). We never silently end it or pick a
// winner — that double sale is SURFACED to the seller (in-app notice + a durable
// platform_fields.oversell_conflict marker on both listings) so they can cancel
// one order. The toDelist/oversold split is the pure planCrossListingSale.
//
// Imports the upstream-end helpers DIRECTLY from ebay-client / shopify-client /
// etsy-api (NOT via the marketplace adapters) so flipdesk-ebay.ts →
// cross-listings.ts stays cycle-free: the eBay adapter imports
// publishItemForOwner from flipdesk-ebay.ts. shopify-client, depop-client and
// etsy-client/etsy-api have no back-edge into this module. NOTE for Etsy
// specifically: import from etsy-api/etsy-client, NEVER from etsy-orders.ts —
// that module imports THIS one, so routing through it would close a cycle.
//
// US-2164 + US-2165: which channel ends a given platform is decided by the pure
// delistMethodFor() rather than a chain of `if (row.platform === …)` branches.
// That chain is what let Etsy fall through silently: it matched no branch, so
// the local row was marked 'ended' while the Etsy listing stayed live and
// purchasable. Dispatching on the planner makes an unhandled platform
// impossible to add by omission — every method needs an arm, and the
// 'unsupported' arm is now a loud, durable marker instead of a no-op.

interface SiblingRow {
  id: string;
  platform: string;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  listing_status: string;
  inventory_items: { user_id: string; sku: string | null };
}

/**
 * Outcome of one auto-end pass, broken out per US-2165 (AC4) so a caller can
 * never report "ended N listings" when some of those N are still live.
 */
export interface AutoEndSummary {
  /** Confirmed ended on the marketplace (or already gone there). */
  ended: number;
  /** Handed to the Lister extension to end in the seller's own tab. */
  queued: number;
  /** Still live upstream — marker stamped, seller notified. */
  unresolved: number;
  /** Never published to that marketplace, so nothing was live to end. */
  nothingLive: number;
}

const EMPTY_SUMMARY = (): AutoEndSummary => ({
  ended: 0,
  queued: 0,
  unresolved: 0,
  nothingLive: 0,
});

// Best-effort: never throws. Returns the per-outcome breakdown above.
export async function autoEndCrossListings(
  ownerId: string,
  soldListingId: string,
): Promise<AutoEndSummary> {
  try {
    const { data: sold } = await supabaseAdmin
      .from("listings")
      .select("draft_id")
      .eq("id", soldListingId)
      .maybeSingle();
    const draftId = (sold as { draft_id: string | null } | null)?.draft_id;
    if (!draftId) return EMPTY_SUMMARY(); // not part of a cross-listing group

    const { data: settings } = await supabaseAdmin
      .from("flipdesk_settings")
      .select("auto_end_cross_listings")
      .eq("user_id", ownerId)
      .maybeSingle();
    const enabled =
      (settings as { auto_end_cross_listings: boolean } | null)
        ?.auto_end_cross_listings !== false;
    if (!enabled) return EMPTY_SUMMARY();

    // Tenant-scoped via inventory_items.user_id (US-268) — listings carry no
    // user_id of their own. We pull 'sold' siblings too (not just live ones) so
    // planCrossListingSale can detect a simultaneous-sale oversell (US-1290).
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select(
        "id, platform, platform_offer_id, platform_listing_id, listing_status, inventory_items!inner(user_id, sku)",
      )
      .eq("draft_id", draftId)
      .eq("inventory_items.user_id", ownerId)
      .neq("id", soldListingId)
      .in("listing_status", ["draft", "active", "sold"]);
    if (error) {
      console.error(
        "[cross-listings] sibling lookup failed:",
        error.message,
      );
      return EMPTY_SUMMARY();
    }

    const { toDelist, oversold } = planCrossListingSale(
      soldListingId,
      (data ?? []) as unknown as SiblingRow[],
    );

    // A sibling already sold on another channel is a double sale — surface it,
    // never auto-resolve (US-1290 AC3). Best-effort; never blocks the delist.
    if (oversold.length > 0) {
      await surfaceOversellConflict(ownerId, soldListingId, oversold);
    }

    const summary: AutoEndSummary = EMPTY_SUMMARY();
    const unresolvedPlatforms = new Set<string>();

    for (const row of toDelist) {
      const outcome = await attemptUpstreamDelist(ownerId, row);

      // The local row is marked ended in EVERY outcome: the garment is gone, so
      // it must stop counting as sellable inventory. What differs is what else
      // we record — a queue stamp for the extension, or an unresolved marker
      // when the marketplace still has a live listing we could not pull.
      const update: Record<string, unknown> = {
        listing_status: "ended",
        is_active: false,
      };
      if (outcome.kind === "queued") {
        // Extension marketplaces (Poshmark/Mercari/Grailed) have no delist API —
        // we can't end them from the server. Stamp delist_requested_at so the
        // GradeThread Lister extension ends it in the seller's own tab next time
        // they're in the app (the writeback clears the stamp). API siblings were
        // already ended upstream, so they need no stamp.
        update.delist_requested_at = new Date().toISOString();
      }
      const { error: updErr } = await supabaseAdmin
        .from("listings")
        .update(update)
        .eq("id", row.id);
      if (updErr) {
        console.error(
          "[cross-listings] failed to end sibling listing:",
          updErr.message,
        );
        continue;
      }

      if (outcome.kind === "unresolved") {
        // US-2165: the listing is STILL LIVE on its marketplace. Record why, so
        // the seller gets a badge + notice instead of a row that merely claims
        // to be ended.
        //
        // Only a NEWLY stamped marker joins the notify set — a duplicate order
        // webhook or a re-sync re-runs this whole pass, and re-notifying on a
        // conflict the seller has already been told about is how a system notice
        // becomes noise people learn to ignore. Same rule as the oversell path.
        const newlyStamped = await stampDelistUnresolved(
          row.id,
          row.platform,
          outcome.reason,
        );
        if (newlyStamped) unresolvedPlatforms.add(row.platform);
        summary.unresolved++;
      } else if (outcome.kind === "queued") {
        summary.queued++;
      } else if (outcome.kind === "nothing_live") {
        summary.nothingLive++;
      } else {
        summary.ended++;
      }
    }

    if (unresolvedPlatforms.size > 0) {
      // 'system' notices are always delivered — a listing we could not pull is
      // an active oversell risk, not a preference.
      const names = [...unresolvedPlatforms].sort();
      const which = names.length === 1
        ? `its ${names[0]} listing`
        : `its listings on ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
      void notifyUser(ownerId, {
        type: "system",
        title: names.length === 1
          ? "A cross-listing may still be live"
          : "Cross-listings may still be live",
        message: `This item sold, but we couldn't end ${which} automatically. ` +
          "End it there so the same item can't sell twice.",
        link: "/dashboard/flipdesk/inventory",
      });
    }

    return summary;
  } catch (err) {
    console.error(
      "[cross-listings] autoEndCrossListings failed:",
      err instanceof Error ? err.message : String(err),
    );
    return EMPTY_SUMMARY();
  }
}

// What happened to ONE sibling's upstream listing. US-2165 (AC4): the caller
// must be able to tell "we ended it on the marketplace" from "we only ended our
// own row", so these are distinct outcomes rather than a single boolean.
type DelistOutcome =
  /** Confirmed ended upstream (or the marketplace reported it already gone). */
  | { kind: "ended" }
  /** No server write API — the Lister extension will end it in the seller's tab. */
  | { kind: "queued" }
  /** Never published to this marketplace, so there is nothing live to end. */
  | { kind: "nothing_live" }
  /** Still live upstream and we could not pull it. Needs the seller. */
  | { kind: "unresolved"; reason: string };

function unresolved(reason: string): DelistOutcome {
  return { kind: "unresolved", reason };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Attempt the upstream delist for one sibling. NEVER throws — every failure path
// becomes an `unresolved` outcome the caller records, because the alternative
// (what this code did before US-2165) is to swallow the error and mark the row
// ended while the listing stays purchasable.
//
// A missing platform id is NOT a failure: a draft sibling that was never
// published has nothing live, so it resolves to `nothing_live` and the local row
// is simply ended. Only a row that WAS published and could not be pulled earns
// the marker — that distinction is what keeps the badge meaningful instead of
// firing on every ordinary draft.
async function attemptUpstreamDelist(
  ownerId: string,
  row: SiblingRow,
): Promise<DelistOutcome> {
  const method = delistMethodFor(row.platform);
  switch (method) {
    case "ebay_api": {
      if (!row.platform_offer_id) return { kind: "nothing_live" };
      try {
        await withdrawOffer(ownerId, row.platform_offer_id);
        return { kind: "ended" };
      } catch (err) {
        // Classify with the SAME helpers the manual end route uses (US-1506 /
        // US-1978) rather than treating every throw as unresolved. A withdraw
        // legitimately fails when the offer is already not live — the seller
        // ended it on eBay, or eBay removed it — and flagging those would put a
        // false "may still be live" banner on ordinary stale rows, which is how
        // a warning becomes noise people stop reading.
        if (isOfferAlreadyEndedError(err)) return { kind: "ended" };
        console.warn(
          "[cross-listings] withdrawOffer during auto-end failed:",
          errText(err),
        );
        // A disconnected account throws BEFORE the withdraw runs, so the listing
        // is definitely still live — the most important case to flag.
        if (isNoEbayConnectionError(err)) {
          return unresolved("Your eBay account isn't connected.");
        }
        return unresolved(`eBay rejected the withdraw: ${errText(err)}`);
      }
    }
    case "shopify_api": {
      // The product id lives in platform_listing_id (Shopify has no separate
      // "offer" concept).
      if (!row.platform_listing_id) return { kind: "nothing_live" };
      try {
        const conn = await getShopifyConnection(ownerId);
        if (!conn) return unresolved("Shopify is no longer connected.");
        // US-710: delist via the GraphQL Admin API (productDelete).
        await deleteProductGraphql(conn.shop, conn.token, row.platform_listing_id);
        return { kind: "ended" };
      } catch (err) {
        console.warn(
          "[cross-listings] Shopify delist during auto-end failed:",
          errText(err),
        );
        return unresolved(`Shopify rejected the delete: ${errText(err)}`);
      }
    }
    case "depop_api": {
      // Depop's products surface is SKU-addressed, so the item's SKU — not a
      // platform listing id — is what identifies the live product (US-714).
      if (!row.inventory_items.sku) return { kind: "nothing_live" };
      try {
        const conn = await getDepopConnection(ownerId);
        if (!conn) return unresolved("Depop is no longer connected.");
        // deleteDepopProduct treats a 404 as already-gone.
        await deleteDepopProduct(conn.token, row.inventory_items.sku);
        return { kind: "ended" };
      } catch (err) {
        console.warn(
          "[cross-listings] Depop delist during auto-end failed:",
          errText(err),
        );
        return unresolved(`Depop rejected the delete: ${errText(err)}`);
      }
    }
    case "etsy_api": {
      // US-2164: the gap this story closes. Etsy matched no branch before, so a
      // live Etsy listing survived the sale of the garment it described.
      if (!row.platform_listing_id) return { kind: "nothing_live" };
      if (!isEtsyEnabled()) {
        return unresolved("The Etsy integration is disabled on this server.");
      }
      try {
        const conn = await getEtsyConnection(ownerId);
        if (!conn?.shopId) return unresolved("Etsy is no longer connected.");
        // setEtsyListingState maps a 404 to "gone" rather than throwing, so an
        // already-removed listing is a success, not an unresolved delist.
        await setEtsyListingState(
          conn.token,
          conn.shopId,
          row.platform_listing_id,
          "inactive",
        );
        return { kind: "ended" };
      } catch (err) {
        console.warn(
          "[cross-listings] Etsy delist during auto-end failed:",
          errText(err),
        );
        return unresolved(`Etsy rejected the delist: ${errText(err)}`);
      }
    }
    case "extension":
      return { kind: "queued" };
    case "unsupported":
      // US-2165: reached by any platform in CROSS_LISTING_PLATFORMS with no
      // delist channel — whatnot today (its listing path is 501 pending
      // US-1662), and anything added later without wiring one.
      return unresolved(
        `FlipDesk can't end ${row.platform} listings automatically yet.`,
      );
  }
}

// US-2165: idempotently record that a sibling could not be pulled from its
// marketplace. Mirrors stampOversellMarker — merges into platform_fields (never
// clobbers it) and returns true only when the marker was NEWLY added, so a
// duplicate order webhook or a re-sync can't re-notify. Deliberately the SAME
// jsonb-marker shape as oversell_conflict and sync_drift so the listing card can
// render it through the existing badge path.
async function stampDelistUnresolved(
  listingId: string,
  platform: string,
  reason: string,
): Promise<boolean> {
  const { data, error: readErr } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  if (readErr) {
    console.error(
      "[cross-listings] delist_unresolved marker read failed:",
      readErr.message,
    );
    return false;
  }
  const pf = ((data as { platform_fields: Record<string, unknown> | null } | null)
    ?.platform_fields ?? {}) as Record<string, unknown>;
  if (pf.delist_unresolved) return false; // already flagged — idempotent

  pf.delist_unresolved = {
    detected_at: new Date().toISOString(),
    platform,
    reason,
  };
  const patch: Record<string, unknown> = { platform_fields: pf };
  const { error: updErr } = await supabaseAdmin
    .from("listings")
    .update(patch)
    .eq("id", listingId);
  if (updErr) {
    console.error(
      "[cross-listings] delist_unresolved marker update failed:",
      updErr.message,
    );
    return false;
  }
  return true;
}

// US-1290 AC3: surface a simultaneous-sale (oversell) conflict. The same physical
// garment sold on more than one channel, so we DON'T touch the already-sold
// sibling — we stamp a durable platform_fields.oversell_conflict marker on both
// listings (drives a UI badge, like sync_drift) and fire ONE in-app notice. The
// marker makes this idempotent against a duplicate order webhook / re-sync: a
// listing already flagged isn't re-stamped and the notice isn't re-sent. Returns
// how many listings were newly flagged this call.
async function surfaceOversellConflict(
  ownerId: string,
  soldListingId: string,
  oversold: SiblingRow[],
): Promise<number> {
  let newlyFlagged = 0;
  for (const row of oversold) {
    // Flag both sides so either listing's card shows the conflict.
    const a = await stampOversellMarker(soldListingId, row.id);
    const b = await stampOversellMarker(row.id, soldListingId);
    if (a || b) newlyFlagged += 1;
  }
  if (newlyFlagged > 0) {
    // 'system' notices are always delivered (the user can't mute an oversell).
    void notifyUser(ownerId, {
      type: "system",
      title: "Possible double sale across marketplaces",
      message:
        "The same item appears to have sold on more than one marketplace. " +
        "Review the orders and cancel one to avoid overselling.",
      link: "/dashboard/flipdesk/reconciliation",
    });
  }
  return newlyFlagged;
}

// Idempotently stamp the oversell marker on one listing. Returns true only when
// the marker was NEWLY added (absent before), so the caller can decide whether to
// notify. Merges into the existing platform_fields jsonb (never clobbers it).
async function stampOversellMarker(
  listingId: string,
  conflictingListingId: string,
): Promise<boolean> {
  const { data, error: readErr } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  if (readErr) {
    console.error(
      "[cross-listings] oversell marker read failed:",
      readErr.message,
    );
    return false;
  }
  const pf = ((data as { platform_fields: Record<string, unknown> | null } | null)
    ?.platform_fields ?? {}) as Record<string, unknown>;
  if (pf.oversell_conflict) return false; // already flagged — idempotent

  pf.oversell_conflict = {
    detected_at: new Date().toISOString(),
    conflicting_listing_id: conflictingListingId,
  };
  // Record<string,unknown> update payload (matches the auto-end pattern above) so
  // the jsonb column write type-checks under the generated Database types.
  const patch: Record<string, unknown> = { platform_fields: pf };
  const { error: updErr } = await supabaseAdmin
    .from("listings")
    .update(patch)
    .eq("id", listingId);
  if (updErr) {
    console.error(
      "[cross-listings] oversell marker update failed:",
      updErr.message,
    );
    return false;
  }
  return true;
}
