// The one writeback that records an extension cross-listing (US-716).
//
// WHY THIS IS A LIB AND NOT A ROUTE BODY. Two callers now report the same
// event, and they arrive over different front doors:
//
//   - the SaaS tab (POST /api/flipdesk/listings/extension-writeback, the user's
//     own session), for a prefill and for the seller's "I published it";
//   - the extension's background worker (POST
//     /api/grading/public/listed-confirm, its own bearer token), the moment its
//     tab-navigation watch sees the live listing URL.
//
// The second is the one that makes publishing automatic, and it exists because
// the first cannot be relied on: the push it used to depend on goes to the
// GradeThread TAB that started the job, and a seller who closed that tab — or
// queued the cross-post from their phone — never had one. Every such publish
// stayed a draft until somebody came back and clicked.
//
// Two copies of ~180 lines of listing-status reasoning would drift, and the
// drift would be silent: one door would promote the row and the other would
// leave it a draft, which is exactly the phantom-vs-stuck-draft pair US-1877
// spent a story pinning down. So the body lives here and both routes call it.
//
// TENANCY (US-268): the caller passes an ownerId it has already resolved, and
// every read below is filtered on it before any write.

import type { Context } from "hono";
import { supabaseAdmin } from "./supabase.ts";
import { failSafe } from "./http-errors.ts";
import { requireFlipdesk } from "./plan-gate.ts";
import { markItemListed } from "./active-listings.ts";
import { completeRelist } from "./extension-relist.ts";

/**
 * The Hono context shape both callers satisfy.
 *
 * Only `userId` is read (by requireFlipdesk); the resolved owner arrives as an
 * argument instead, because the two front doors resolve it differently — the
 * SaaS route through the workspace middleware, the extension route through its
 * own bearer token.
 */
export type WritebackEnv = { Variables: { userId: string } };

export interface ExtensionWritebackBody {
  item_id?: unknown;
  platform?: unknown;
  listing_url?: unknown;
  published?: unknown;
}

// ── US-716: GradeThread Lister browser-extension writeback ────────────────
//
// The companion extension (extension/) lists Poshmark/Mercari/Grailed from the
// seller's OWN logged-in tab — GradeThread servers never see a marketplace
// password or cookie. Once the extension reports it prefilled the form, the
// SaaS calls this endpoint (with the user's own session) to record the
// cross-listing so the item shows as cross-listed. We mint/refresh ONE listings
// row per (item, platform), joined to the item's existing cross-list group via
// draft_id (US-149). Tenant-scoped per US-268: ownership of the item is
// verified before any write (the service-role client bypasses RLS).

// Platforms the extension automates (no write API; depop has its own API path).
//
// 2026-08-11: vinted added with its go-live. Without it this route rejected the
// writeback with "vinted is not a browser-extension platform" — so the extension
// would have prefilled the form correctly and the cross-listing would never have
// been recorded, leaving the seller with a live Vinted listing FlipDesk did not
// know about. That is the same class of silent gap as an unrecorded delist.
//
// Facebook stays out until its selectors flow is enabled.
const EXTENSION_PLATFORMS = ["poshmark", "mercari", "grailed", "vinted"] as const;
type ExtensionPlatform = (typeof EXTENSION_PLATFORMS)[number];
function isExtensionPlatform(p: string): p is ExtensionPlatform {
  return (EXTENSION_PLATFORMS as readonly string[]).includes(p);
}

/**
 * Record (or promote) one extension cross-listing. Returns the Response to send.
 */
export async function handleExtensionWriteback<E extends WritebackEnv>(
  c: Context<E>,
  ownerId: string,
  body: ExtensionWritebackBody,
): Promise<Response> {
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  const platform = typeof body.platform === "string" ? body.platform : "";
  const listingUrl =
    typeof body.listing_url === "string" && body.listing_url.length > 0
      ? body.listing_url
      : null;

  // US-1877 (AC2): PREFILLING IS NOT PUBLISHING.
  //
  // This route recorded listing_status:'active' + is_active + listed_at:now on
  // every call — at the moment the extension merely PREFILLED a form the seller
  // had not yet submitted, and might never submit. Combined with listing_url being
  // permanently null (GT.captureListingUrl was referenced in a comment but never
  // existed), every "Send to extension" minted a phantom active listing: the
  // seller's inventory claimed a live cross-listing that did not exist anywhere.
  //
  // Now the default is a DRAFT, and only an explicit confirmation — the captured
  // live URL, or the seller saying "I published it" — promotes it to active.
  // Defaulting to false matters: an older client that doesn't send the flag gets
  // the safe state (a draft it can promote) rather than the phantom.
  const published = body.published === true;

  if (!itemId) return c.json({ error: "item_id is required." }, 400);
  if (!isExtensionPlatform(platform)) {
    return c.json(
      { error: `${platform || "platform"} is not a browser-extension platform.` },
      400,
    );
  }

  // Verify the caller owns the item (US-268).
  const { data: itemRow, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id, target_price, status")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr) {
    return failSafe(
      c,
      500,
      "Could not load the item.",
      itemErr,
      "flipdesk.extension-writeback.item",
      "WRITEBACK_ITEM_LOAD",
    );
  }
  const item = itemRow as
    | {
      id: string;
      user_id: string;
      target_price: number | null;
      status: string | null;
    }
    | null;
  if (!item || item.user_id !== ownerId) {
    return c.json({ error: "Item not found." }, 404);
  }

  // US-2179: a CONFIRMED publish on an extension platform (Poshmark/Mercari/
  // Grailed) is a live listing and consumes an activeListings slot, so gate it
  // like every other publish. Only when `published` — a prefill that stays a
  // draft costs nothing, which is exactly the US-1877 distinction, so a seller
  // at their cap can still prep drafts and publish them after upgrading.
  if (published) {
    const capGate = await requireFlipdesk(c, {
      capacity: {
        kind: "activeListings",
        delta: item.status === "listed" ? 0 : 1,
      },
      userId: ownerId,
    });
    if (capGate) return capGate;
  }

  // Join to the item's cross-list group (the eBay base draft), if any.
  //
  // US-2726: the error was dropped here, and that is what made the real failure
  // undiagnosable. This SELECT names `draft_id`; when production PostgREST did
  // not know that column, the query failed, `baseRow` came back undefined, and
  // the route read that as "this item has no group" and carried on — until the
  // INSERT named the same column and finally raised. A lookup that could not RUN
  // must never be indistinguishable from a lookup that found nothing.
  const { data: baseRow, error: baseErr } = await supabaseAdmin
    .from("listings")
    .select("id, draft_id, listing_price")
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (baseErr) {
    return failSafe(
      c,
      500,
      "Could not load the item's cross-listing group.",
      baseErr,
      "flipdesk.extension-writeback.group",
      "WRITEBACK_GROUP_LOAD",
    );
  }
  const base = baseRow as
    | { id: string; draft_id: string | null; listing_price: number | null }
    | null;
  const groupId = base?.draft_id ?? base?.id ?? null;

  // First POSITIVE wins, not first non-null: a stale 0 on the draft row must not
  // shadow the item's target price. `inventory_items` has no `list_price` — that
  // is a column on the `items_full` view — so there is no third source here.
  const price =
    [base?.listing_price, item.target_price].find(
      (p): p is number => p != null && p > 0,
    ) ?? 0;

  const now = new Date().toISOString();

  // One row per (item, platform): refresh it if it already exists, else create.
  // Same rule as the group lookup above: a SELECT that errors must not read as
  // "no existing row", which would send us down the INSERT path and create a
  // duplicate listing for a platform that already has one.
  const { data: existingRow, error: existingErr } = await supabaseAdmin
    .from("listings")
    .select("id, listing_status, listing_url, listed_at, platform_fields")
    .eq("inventory_item_id", itemId)
    .eq("platform", platform)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const existing = existingRow as
    | {
      id: string;
      listing_status: string | null;
      listing_url: string | null;
      listed_at: string | null;
      platform_fields: Record<string, unknown> | null;
    }
    | null;

  // US-9203: the latest row is a relist COPY and the seller just posted it.
  // Completing the relist activates the copy, ends the old row and queues the
  // old listing's removal; treating it as an ordinary writeback would leave
  // two rows and the stale one live.
  if (
    published && listingUrl && existing &&
    typeof existing.platform_fields?.relist_of === "string"
  ) {
    const done = await completeRelist(ownerId, existing.id, listingUrl);
    if (!done.ok) return c.json({ error: done.error }, done.status);
    return c.json({
      ok: true,
      listing_id: existing.id,
      platform,
      created: false,
      published: true,
      relisted_from: done.old_listing_id,
      old_delist_queued: done.old_delist_queued,
    });
  }
  if (existingErr) {
    return failSafe(
      c,
      500,
      "Could not check for an existing cross-listing.",
      existingErr,
      "flipdesk.extension-writeback.existing",
      "WRITEBACK_EXISTING_LOAD",
    );
  }

  if (existing) {
    const patch: Record<string, unknown> = { draft_id: groupId ?? undefined };
    if (published) {
      patch.listing_status = "active";
      patch.is_active = true;
      patch.listed_at = existing.listed_at ?? now;
      // Never blank a URL we already have: a manual "I published it" carries no
      // URL, and it must not erase one the capture already found.
      if (listingUrl) patch.listing_url = listingUrl;
    } else if (existing.listing_status !== "active") {
      // A re-prefill of a row that is still a draft stays a draft.
      patch.listing_status = "draft";
      patch.is_active = false;
    }
    // NOTE the else: a prefill of an ALREADY-ACTIVE listing leaves it active. A
    // seller re-sending a live listing to the extension (to fix a typo) must not
    // have it demoted to draft — that would make a real live listing invisible to
    // the delist queue, which is the same oversell hazard from the other side.
    const { error: upErr } = await supabaseAdmin
      .from("listings")
      .update(patch)
      .eq("id", existing.id);
    if (upErr) {
      return failSafe(
        c,
        500,
        "Could not update the cross-listing.",
        upErr,
        "flipdesk.extension-writeback.update",
        "WRITEBACK_UPDATE",
      );
    }
    // US-2179: count a confirmed extension publish against the cap.
    if (published) await markItemListed(itemId, ownerId);
    return c.json({
      ok: true,
      listing_id: existing.id,
      platform,
      created: false,
      published: published || existing.listing_status === "active",
    });
  }

  const { data: created, error: insErr } = await supabaseAdmin
    .from("listings")
    .insert({
      inventory_item_id: itemId,
      platform,
      // US-1077: recording a FlipDesk cross-listing → GradeThread-originated.
      listing_origin: "gradethread",
      // US-1877 (AC2): 'draft' unless the seller has actually published. Reuses the
      // existing listing_status enum value ('draft','active','ended','sold',
      // 'relisted' — 00008) rather than minting a 'prefilled' one, so no migration
      // and no new state for every consumer of listing_status to learn.
      listing_status: published ? "active" : "draft",
      is_active: published,
      listing_price: price,
      listing_url: listingUrl,
      // A draft was never listed — a listed_at here is what made phantom rows look
      // like real, dateable cross-listings in the pipeline.
      listed_at: published ? now : null,
      draft_id: groupId,
    })
    .select("id")
    .single();
  if (insErr || !created) {
    // US-2725: this branch returned a bare 500 and threw the Postgres error
    // away. A seller hit it twice in production on 2026-08-20 with a filled-in
    // Poshmark form in front of them, and the edge log held nothing but the
    // status — there was no way to tell a constraint violation from a missing
    // column from a stale PostgREST schema cache.
    return failSafe(
      c,
      500,
      "Could not record the cross-listing.",
      insErr ?? new Error("insert returned no row"),
      "flipdesk.extension-writeback.insert",
      "WRITEBACK_INSERT",
    );
  }
  // US-2179: count a confirmed extension publish against the cap.
  if (published) await markItemListed(itemId, ownerId);
  return c.json({
    ok: true,
    listing_id: (created as { id: string }).id,
    platform,
    created: true,
    published,
  });
}

