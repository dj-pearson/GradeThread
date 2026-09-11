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
import { deliverExtensionWake, notifyUser } from "./notify.ts";
import {
  delistMethodFor,
  planCrossListingSale,
} from "./cross-listing-sale.ts";
import { enqueueExtensionWork } from "./extension-enqueue.ts";
import { pushDelistNeeded } from "./transactional-push.ts";
import {
  isAutoDelistable,
  loadSellerHandles,
  loadVariantTitles,
  matchTitlesFor,
} from "./pending-delists.ts";

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

export interface SiblingRow {
  id: string;
  platform: string;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  listing_status: string;
  /** US-3141: the page the extension opens to end it. Null = manual path only. */
  listing_url: string | null;
  /** US-3141: carried onto the queue row so the seller's queue view names the item. */
  inventory_item_id: string | null;
  /** US-3369: the cross-listing group, which is now only the OVERSELL scope. */
  draft_id?: string | null;
  /** US-3369: what the extension searches for when it has no listing_url. */
  listing_title?: string | null;
  inventory_items: { user_id: string; sku: string | null; title?: string | null };
}

/**
 * US-3369: which listings a pass ends.
 *
 * `itemId` is the garment. `draftId` is the cross-listing group the sold row
 * belongs to, when it has one. `soldListingId` is the row that sold, or null
 * when the seller recorded a sale somewhere FlipDesk has no listing for.
 */
export interface EndOtherListingsTarget {
  itemId: string | null;
  draftId: string | null;
  soldListingId: string | null;
}

const SIBLING_COLUMNS =
  "id, platform, platform_offer_id, platform_listing_id, listing_status, draft_id, " +
  // US-3141: listing_url and inventory_item_id are what the queued delist job
  // needs — the URL the extension opens, and the item the seller's queue view
  // names it by. US-3369: listing_title and the item title are what it
  // searches for when there is no URL.
  "listing_url, listing_title, inventory_item_id, " +
  "inventory_items!inner(user_id, sku, title)";

/**
 * US-3369: keep only the rows a pass may act on. Pure.
 *
 * Live rows (draft/active) of the same ITEM are all siblings: one garment, so a
 * sale anywhere ends it everywhere. That is wider than it used to be, and on
 * purpose — the draft_id group was the only key, and extension-only items never
 * get one (the writeback joins an eBay row's group, and there is no eBay row)
 * while an eBay base that was never cross-pushed does not point at itself. Both
 * left a Poshmark sale ending nothing.
 *
 * A SOLD row still counts only inside the draft_id group. Item-wide, a sold row
 * is as likely to be last spring's sale of a garment that came back and was
 * relisted as it is a double sale, and a false oversell alarm on every returned
 * item is how that warning stops being read.
 */
export function selectSiblingRows<
  T extends { id: string; listing_status: string; draft_id?: string | null },
>(rows: readonly T[], target: EndOtherListingsTarget): T[] {
  return rows.filter((r) => {
    if (target.soldListingId && r.id === target.soldListingId) return false;
    if (r.listing_status === "sold") {
      return !!target.draftId && r.draft_id === target.draftId;
    }
    return r.listing_status === "draft" || r.listing_status === "active";
  });
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

/**
 * US-3367: the group is "rows whose draft_id is X" PLUS the anchor row X
 * itself. The extension writeback sets draft_id on the Poshmark row but never
 * on the eBay draft it points at, so without the second clause a Poshmark sale
 * found no eBay sibling and eBay stayed live. `.or()` on a SELECT is fine;
 * US-1552 is about mutations.
 */
export function siblingSelector(draftId: string): string {
  return `draft_id.eq.${draftId},id.eq.${draftId}`;
}

// Best-effort: never throws. Returns the per-outcome breakdown above.
//
// The automatic path, run by every sale webhook and the sold-sync. Honours the
// seller's auto_end_cross_listings switch; the explicit Delist button does not
// (see endOtherListings).
export async function autoEndCrossListings(
  ownerId: string,
  soldListingId: string,
): Promise<AutoEndSummary> {
  try {
    // US-268: the sold row is read through its owner-scoped parent like every
    // other read in this module.
    const { data: sold } = await supabaseAdmin
      .from("listings")
      .select("draft_id, inventory_item_id, inventory_items!inner(user_id)")
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
        "id, platform, platform_offer_id, platform_listing_id, listing_status, " +
          // US-3141: listing_url and inventory_item_id are what the queued
          // delist job needs — the URL the extension opens, and the item the
          // seller's queue view names it by.
          "listing_url, inventory_item_id, inventory_items!inner(user_id, sku)",
      )
      .or(siblingSelector(draftId))
      .eq("inventory_items.user_id", ownerId)
      .maybeSingle();
    const s = sold as
      | { draft_id: string | null; inventory_item_id: string | null }
      | null;
    // US-3369: an item id is enough. Returning here whenever draft_id was null
    // is what made a Poshmark sale of an extension-only item end nothing.
    if (!s || (!s.draft_id && !s.inventory_item_id)) return EMPTY_SUMMARY();

    return await endOtherListings(
      ownerId,
      { itemId: s.inventory_item_id, draftId: s.draft_id, soldListingId },
      { honorSetting: true },
    );
  } catch (err) {
    console.error(
      "[cross-listings] autoEndCrossListings failed:",
      err instanceof Error ? err.message : String(err),
    );
    return EMPTY_SUMMARY();
  }
}

/**
 * End every other live listing of one garment. The engine behind both the
 * automatic path above and the seller's own Delist button (US-3369).
 *
 * `honorSetting: false` is for the button. A seller who switched automatic
 * ending off and then pressed "Delist from other platforms" has asked, in the
 * plainest way available, for exactly this.
 *
 * Best-effort: never throws.
 */
export async function endOtherListings(
  ownerId: string,
  target: EndOtherListingsTarget,
  opts: { honorSetting: boolean },
): Promise<AutoEndSummary> {
  try {
    if (!target.itemId && !target.draftId) return EMPTY_SUMMARY();

    if (opts.honorSetting) {
      const { data: settings } = await supabaseAdmin
        .from("flipdesk_settings")
        .select("auto_end_cross_listings")
        .eq("user_id", ownerId)
        .maybeSingle();
      const enabled =
        (settings as { auto_end_cross_listings: boolean } | null)
          ?.auto_end_cross_listings !== false;
      if (!enabled) return EMPTY_SUMMARY();
    }

    // Tenant-scoped via inventory_items.user_id (US-268). We pull 'sold'
    // siblings too (not just live ones) so planCrossListingSale can detect a
    // simultaneous-sale oversell (US-1290); selectSiblingRows decides which of
    // those count.
    let q = supabaseAdmin
      .from("listings")
      .select(SIBLING_COLUMNS)
      .eq("inventory_items.user_id", ownerId)
      .in("listing_status", ["draft", "active", "sold"]);
    // Both keys are ids read from our own rows, never from a request, so they
    // are safe inside the filter string. .or() on a SELECT is fine; it is
    // mutations the self-hosted PostgREST refuses it on (US-1552).
    if (target.itemId && target.draftId) {
      q = q.or(`inventory_item_id.eq.${target.itemId},draft_id.eq.${target.draftId}`);
    } else if (target.itemId) {
      q = q.eq("inventory_item_id", target.itemId);
    } else {
      q = q.eq("draft_id", target.draftId as string);
    }
    if (target.soldListingId) q = q.neq("id", target.soldListingId);

    const { data, error } = await q;
    if (error) {
      console.error(
        "[cross-listings] sibling lookup failed:",
        error.message,
      );
      return EMPTY_SUMMARY();
    }

    const { toDelist, oversold } = planCrossListingSale(
      target.soldListingId ?? "",
      selectSiblingRows((data ?? []) as unknown as SiblingRow[], target),
    );

    // A sibling already sold on another channel is a double sale — surface it,
    // never auto-resolve (US-1290 AC3). Best-effort; never blocks the delist.
    // Needs the sold row to name the pair, so a sale with no listing skips it.
    if (oversold.length > 0 && target.soldListingId) {
      await surfaceOversellConflict(ownerId, target.soldListingId, oversold);
    }

    const summary: AutoEndSummary = EMPTY_SUMMARY();
    const unresolvedPlatforms = new Set<string>();
    /** US-3144: the siblings handed to the browser, for ONE notice at the end. */
    const queuedRows: SiblingRow[] = [];
    /** US-3369: read once per pass, and only if something is queued. */
    let searchAids: SearchAids | null = null;

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
        // Extension marketplaces (Poshmark/Mercari/Grailed/Vinted/Facebook) have
        // no delist API — we can't end them from the server. Stamp
        // delist_requested_at so the GradeThread Lister extension ends it in the
        // seller's own tab (the writeback clears the stamp). API siblings were
        // already ended upstream, so they need no stamp.
        //
        // The stamp is the MANUAL path: it feeds loadPendingDelists, which the
        // SaaS and the extension popup both render for the seller to click.
        // queueExtensionDelist below is the hands-off path. Both, always —
        // the stamp is what still works when the queue refuses the job.
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
        // US-3141: hand it to the extension's background drain as well as to the
        // seller. AFTER the update, so a row we failed to mark ended is never
        // queued for a browser to end.
        searchAids ??= await loadSearchAids(ownerId, row.inventory_item_id);
        await queueExtensionDelist(ownerId, row, searchAids);
        // US-3144: collected, not notified per row. See the send below.
        queuedRows.push(row);
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
        : `its listings on ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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

    // US-3144: ONE notice per sale, after the loop, naming the item and how many
    // listings are still live. Deliberately not per sibling: a seller who
    // cross-listed to four channels and sold on the fifth does not need four
    // buzzes about one garment.
    //
    // This is the gap the whole phone story exists for. Until now the `queued`
    // outcome told the seller NOTHING — the row was stamped, the desktop queue
    // was filled, and if their browser stayed shut the listing sat live until
    // the queue expired a week later. Only the `unresolved` case above ever
    // spoke.
    //
    // Idempotent by the same mechanism US-3141 relies on: a sibling is flipped
    // to 'ended' before this point, and the sibling query only selects
    // draft/active/sold, so a duplicate order webhook re-runs the pass and finds
    // nothing left to queue.
    if (queuedRows.length > 0) {
      await notifyDelistNeeded(ownerId, queuedRows);
    }

    return summary;
  } catch (err) {
    console.error(
      "[cross-listings] endOtherListings failed:",
      err instanceof Error ? err.message : String(err),
    );
    return EMPTY_SUMMARY();
  }
}

/**
 * US-3369: what a queued delist carries so the extension can FIND a listing it
 * has no link to: the seller's saved usernames, and the per-platform titles the
 * listing kit stored for this item.
 */
interface SearchAids {
  handles: Record<string, string>;
  variantTitles: Record<string, string>;
}

async function loadSearchAids(ownerId: string, itemId: string | null): Promise<SearchAids> {
  const [handles, variants] = await Promise.all([
    loadSellerHandles(ownerId),
    itemId ? loadVariantTitles(ownerId, [itemId]) : Promise.resolve(new Map()),
  ]);
  return {
    handles,
    variantTitles: (itemId ? variants.get(itemId) : undefined) ?? {},
  };
}

/**
 * US-3144: tell the seller their sold item is still listed somewhere.
 *
 * ONE notice per sale. It goes out on three channels and each one is doing a
 * different job:
 *
 *   - notifyUser writes the in-app row and, through deliverPush, the browser
 *     web push. Gated on the `delist_reminders` preference, which is its own
 *     category precisely so a seller can keep sale notifications and turn this
 *     one off (or the reverse).
 *   - pushDelistNeeded reaches the phone. That is the case this exists for: the
 *     desktop path (US-3141 + US-3142) already handles a browser that is open,
 *     and does nothing at all for a seller whose laptop is shut.
 *
 * The item title is one extra read, and it is worth it. "An item sold and two
 * listings are still live" sends a seller hunting through their inventory; the
 * garment's name does not.
 *
 * NEVER THROWS. A notification failure must not break an auto-end pass that has
 * already done the important work — the rows are ended and queued by this point,
 * and the pending-delist list on every surface is built from the stamp, not from
 * this message.
 */
async function notifyDelistNeeded(
  ownerId: string,
  queued: readonly SiblingRow[],
): Promise<void> {
  try {
    // Siblings in a cross-listing group are the same garment on different
    // marketplaces, so they share an item. Taking the first is not a guess.
    const itemId = queued.find((r) => r.inventory_item_id)?.inventory_item_id ?? null;

    let title: string | null = null;
    if (itemId) {
      const { data } = await supabaseAdmin
        .from("inventory_items")
        .select("title")
        .eq("id", itemId)
        .eq("user_id", ownerId) // US-268
        .maybeSingle();
      title = (data as { title: string | null } | null)?.title ?? null;
    }

    const platforms = [...new Set(queued.map((r) => r.platform))].sort();
    const which = platforms.length === 1
      ? `your ${platforms[0]} listing`
      : `your listings on ${platforms.slice(0, -1).join(", ")} and ${platforms[platforms.length - 1]}`;
    const what = title ? `"${title}"` : "An item";

    // The link carries the item so the phone and the web both land on that
    // garment's pending delists rather than the whole queue.
    const link = itemId
      ? `/dashboard/flipdesk/inventory?item=${itemId}&pendingDelists=1`
      : "/dashboard/flipdesk/inventory";

    await notifyUser(ownerId, {
      type: "delist_needed",
      title: queued.length === 1 ? "One listing still live" : "Listings still live",
      message: `${what} sold, so we ended it here — but ${which} can only be ` +
        "ended from your own browser. End it before the same item sells twice.",
      link,
    });

    void pushDelistNeeded(ownerId, {
      itemId,
      itemTitle: title,
      count: queued.length,
    });
  } catch (err) {
    console.warn(
      "[cross-listings] could not send the delist-needed notice:",
      errText(err),
    );
  }
}

/**
 * US-3369: what a queued delist tells the extension. Pure, exported for tests.
 *
 * `listingUrl` when we have one, which is the precise path. `matchTitles` and
 * `sellerHandle` are for when we do not: the extension opens the platform's
 * active-listings page from its OWN config and looks for these words there.
 * None of it is a URL the extension will navigate to, and none of it is a
 * credential (enqueueExtensionWork refuses those by key).
 */
export function buildDelistQueuePayload(
  row: SiblingRow,
  aids: { handles: Record<string, string>; variantTitles: Record<string, string> },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (row.listing_url) payload.listingUrl = row.listing_url;
  const titles = matchTitlesFor([
    row.listing_title,
    aids.variantTitles[row.platform],
    row.inventory_items.title,
  ]);
  if (titles.length > 0) payload.matchTitles = titles;
  const handle = aids.handles[row.platform];
  if (handle) payload.sellerHandle = handle;
  return payload;
}

/**
 * US-3141: queue the sibling's delist for the extension's background drain.
 *
 * WHAT THIS CLOSES. The extension has claimed extension_work_queue rows every
 * five minutes and on browser start since US-2481, and 'delist' has always been
 * a runnable kind — it opens the listing in an unfocused tab in the seller's own
 * logged-in session and ends it. Nothing ever put a SALE-triggered delist into
 * that queue. The stamp alone means the sibling waits, live and purchasable,
 * until the seller happens to open FlipDesk or the popup and click. The robot
 * was already there; the sale just never spoke to it.
 *
 * NO CREDENTIAL IS INVOLVED, and that is not incidental. The queue stores WHAT
 * to do — a platform and the seller's own listing URL — and enqueueExtensionWork
 * refuses any payload carrying a password or session key. The marketplace
 * session stays in the seller's browser, which is the whole reason this path
 * exists instead of a server-side login.
 *
 * NEVER THROWS. Auto-end is best-effort per sibling; a refusal here (a lapsed
 * FlipDesk plan, the queue depth cap) leaves delist_requested_at stamped, so the
 * seller still sees it in the pending queue and can end it by hand. Losing the
 * automation is a slower delist; aborting the pass would leave the REMAINING
 * siblings untouched, which is a double sale.
 */
// MERGED 2026-09-11: ours took three arguments and theirs exported a
// two-argument version. `aids` is READ in the body (buildDelistQueuePayload)
// and cross-listing-delist_test.ts pins the three-argument call, so the
// parameter stays; it is optional so the two-argument caller added in
// listing-lifecycle.ts compiles, and exported so that caller can reach it.
export async function queueExtensionDelist(
  ownerId: string,
  row: SiblingRow,
  aids: SearchAids = { handles: {}, variantTitles: {} },
): Promise<void> {
  // The same rule the popup and the SaaS answer with, imported rather than
  // restated — pending-delists.ts documents what a second copy of this list
  // already cost once.
  //
  // Plus one condition only THIS path needs: the row must have been confirmed
  // live. A draft was only ever prefilled, and a background search for a
  // listing that was never posted reports a failure the seller did not cause.
  // A draft is still searched when the seller presses Delist themselves; that
  // is a person asking, not a robot guessing.
  if (row.listing_status !== "active") return;
  if (!isAutoDelistable(row.platform, row.listing_url)) return;

  try {
    // Two order webhooks for the same sale can both read this sibling as live
    // before either update lands. Two queue rows is two background tabs opening
    // the same listing, the second finding it already ended and reporting a
    // failure against an item that was handled correctly.
    const { data: existing } = await supabaseAdmin
      .from("extension_work_queue")
      .select("id")
      .eq("user_id", ownerId) // US-268
      .eq("listing_id", row.id)
      .eq("kind", "delist")
      .in("status", ["queued", "claimed"])
      .limit(1)
      .maybeSingle();
    if (existing) return;

    const result = await enqueueExtensionWork(ownerId, {
      kind: "delist",
      platform: row.platform,
      listing_id: row.id,
      inventory_item_id: row.inventory_item_id,
      payload: buildDelistQueuePayload(row, aids),
      source: "cross-listing-sale",
    });
    if (!result.ok) {
      console.warn(
        `[cross-listings] could not queue the ${row.platform} delist for the ` +
          `extension (${result.status}): ${result.error}. The listing is stamped, ` +
          `so the seller still sees it in their pending delists.`,
      );
      return;
    }

    // US-3142: the row is in the queue; now wake the browser that drains it.
    // Only on a real enqueue — a wake sent after a refusal would start a drain
    // that finds nothing, which is the one way this can become noise.
    //
    // Not awaited, and it cannot throw: deliverExtensionWake swallows every
    // failure. The queue row is what makes the delist happen; the wake only
    // decides whether it happens now or within five minutes.
    void deliverExtensionWake(ownerId);
  } catch (err) {
    console.warn(
      "[cross-listings] queueing the extension delist threw:",
      errText(err),
    );
  }
}

// What happened to ONE sibling's upstream listing. US-2165 (AC4): the caller
// must be able to tell "we ended it on the marketplace" from "we only ended our
// own row", so these are distinct outcomes rather than a single boolean.
export type DelistOutcome =
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
//
// US-2164 (AC5): the marketplace calls are injectable so the dispatch itself is
// unit-testable without a network or a DB. That matters most for the arms whose
// correctness is a CLASSIFICATION rather than a call — a disabled Etsy connector
// must produce an `unresolved` marker, not a clean `ended`, and there is no way
// to assert that from the outside. Defaults wire to the real implementations, so
// production behaviour is unchanged; only tests pass deps.
export interface DelistDeps {
  withdrawOffer: (ownerId: string, offerId: string) => Promise<unknown>;
  isOfferAlreadyEndedError: (err: unknown) => boolean;
  isNoEbayConnectionError: (err: unknown) => boolean;
  getShopifyConnection: (
    ownerId: string,
  ) => Promise<{ shop: string; token: string } | null>;
  deleteProductGraphql: (
    shop: string,
    token: string,
    productId: string,
  ) => Promise<unknown>;
  getDepopConnection: (ownerId: string) => Promise<{ token: string } | null>;
  deleteDepopProduct: (token: string, sku: string) => Promise<unknown>;
  isEtsyEnabled: () => boolean;
  getEtsyConnection: (
    ownerId: string,
  ) => Promise<{ token: string; shopId: string | null } | null>;
  setEtsyListingState: (
    token: string,
    shopId: string,
    listingId: string,
    state: "active" | "inactive",
  ) => Promise<unknown>;
}

const defaultDelistDeps: DelistDeps = {
  withdrawOffer,
  isOfferAlreadyEndedError,
  isNoEbayConnectionError,
  getShopifyConnection,
  deleteProductGraphql,
  getDepopConnection,
  deleteDepopProduct,
  isEtsyEnabled,
  getEtsyConnection,
  setEtsyListingState,
};

export async function attemptUpstreamDelist(
  ownerId: string,
  row: SiblingRow,
  deps: DelistDeps = defaultDelistDeps,
): Promise<DelistOutcome> {
  const {
    withdrawOffer,
    isOfferAlreadyEndedError,
    isNoEbayConnectionError,
    getShopifyConnection,
    deleteProductGraphql,
    getDepopConnection,
    deleteDepopProduct,
    isEtsyEnabled,
    getEtsyConnection,
    setEtsyListingState,
  } = deps;
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
