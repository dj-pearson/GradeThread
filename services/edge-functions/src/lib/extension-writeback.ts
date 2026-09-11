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
import { markItemListed, resyncItemListedStatus } from "./active-listings.ts";
import { completeRelist } from "./extension-relist.ts";
import { delistMethodFor } from "./cross-listing-sale.ts";
import { getMarketplaceSpec } from "./marketplace-specs.ts";
import { notifyExtensionListed } from "./selling-activity-notify.ts";

// ── US-3367: a filled form is recorded as listed, and the seller opts OUT ────
//
// US-1877 recorded a prefill as a DRAFT and promoted it only on a captured URL
// or the seller's "I published it". The founder reversed the default on
// 2026-09-11: a seller who fills the Poshmark form and forgets to press "I
// published it" ends up with a garment that is live on Poshmark and invisible
// to FlipDesk, and finds out when it sells somewhere else. Recording the row as
// listed-but-unconfirmed means the sale flow tells them to check Poshmark, and
// "Not listed" is one click when the record is wrong. Opt-out, not opt-in.
//
// The marker lives on platform_fields so no migration is needed and the row
// reads `active` to everything that counts live listings. A captured URL or
// the seller's confirmation clears it.
export const LISTED_UNCONFIRMED_KEY = "listed_unconfirmed";

/** Should a prefill be recorded as listed (unconfirmed) rather than a draft? */
export const PREFILL_RECORDS_AS_LISTED = true;

export function withUnconfirmedMarker(
  fields: Record<string, unknown> | null | undefined,
  now: string,
): Record<string, unknown> {
  return { ...(fields ?? {}), [LISTED_UNCONFIRMED_KEY]: { at: now } };
}

export function withoutUnconfirmedMarker(
  fields: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!fields || !(LISTED_UNCONFIRMED_KEY in fields)) return null;
  const rest = { ...fields };
  delete rest[LISTED_UNCONFIRMED_KEY];
  return rest;
}

export function hasUnconfirmedMarker(
  fields: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(fields && fields[LISTED_UNCONFIRMED_KEY]);
}

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
 * The UPDATE payload for a writeback against a listings row that already exists.
 *
 * Pure and exported so the listed_at rule can be CALLED by a test rather than
 * spell-checked by a source scan. The rule below is logic, and a scan on logic
 * only ever pins the spelling of a gate, never its answer.
 *
 * US-2727, the half that migration 00634 did not close. 00634 dropped NOT NULL
 * so the INSERT further down can write an explicit null for a draft, and it
 * deliberately KEPT `DEFAULT now()` because changing the default would change
 * behaviour for every writer that omits the column. Several of those writers
 * create DRAFT rows: lib/cross-push.ts, lib/extension-relist.ts and
 * lib/ai-listing.ts all insert `listing_status:'draft'` without naming
 * listed_at, so the default stamps the row with the moment the DRAFT was made.
 *
 * That is why `existing.listed_at ?? now` was wrong. Promoting such a row kept
 * a timestamp that was never a listing date, backdating the publish to whenever
 * the draft happened to be created. The stale-listing filters in 00560
 * (`views_total = 0 AND listed_at <= now() - 14 days`) and every days-listed
 * readout take that value at face value.
 *
 * So: keep the stored date only when the row was NOT a draft, where it is a
 * real marketplace date that must not move when a seller re-confirms a live
 * listing. A draft being published is being listed NOW, whatever the column
 * happens to hold.
 */
export function buildWritebackPatch(args: {
  published: boolean;
  existingStatus: string | null;
  existingListedAt: string | null;
  listingUrl: string | null;
  groupId: string | null;
  now: string;
  /**
   * US-3367: record a prefill as listed-unconfirmed instead of a draft. Off by
   * default so the pure rules above stay what they were; the route passes
   * PREFILL_RECORDS_AS_LISTED (minus the cap gate's veto).
   */
  prefillAsListed?: boolean;
  /** The row's platform_fields, so the marker can be added or removed. */
  existingPlatformFields?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = { draft_id: args.groupId ?? undefined };
  if (args.published) {
    patch.listing_status = "active";
    patch.is_active = true;
    patch.listed_at = args.existingStatus === "draft"
      ? args.now
      : (args.existingListedAt ?? args.now);
    // Never blank a URL we already have: a manual "I published it" carries no
    // URL, and it must not erase one the capture already found.
    if (args.listingUrl) patch.listing_url = args.listingUrl;
    // A confirmation settles the question the marker asked.
    const cleared = withoutUnconfirmedMarker(args.existingPlatformFields);
    if (cleared) patch.platform_fields = cleared;
  } else if (args.existingStatus !== "active") {
    if (args.prefillAsListed) {
      // US-3367: the form was filled, so the garment is listed until the seller
      // says otherwise. It is being listed NOW, whatever the draft's default
      // listed_at happens to hold (see the US-2727 note above).
      patch.listing_status = "active";
      patch.is_active = true;
      patch.listed_at = args.now;
      patch.platform_fields = withUnconfirmedMarker(args.existingPlatformFields, args.now);
    } else {
      // A re-prefill of a row that is still a draft stays a draft.
      patch.listing_status = "draft";
      patch.is_active = false;
    }
  }
  // NOTE the else: a prefill of an ALREADY-ACTIVE listing leaves it active. A
  // seller re-sending a live listing to the extension (to fix a typo) must not
  // have it demoted to draft, which would make a real live listing invisible to
  // the delist queue, the same oversell hazard from the other side.
  return patch;
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
    .select("id, user_id, target_price, status, title")
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
      title: string | null;
    }
    | null;
  if (!item || item.user_id !== ownerId) {
    return c.json({ error: "Item not found." }, 404);
  }

  // US-2179: a CONFIRMED publish on an extension platform (Poshmark/Mercari/
  // Grailed) is a live listing and consumes an activeListings slot, so gate it
  // like every other publish.
  //
  // US-3367: a prefill is recorded as listed too (unconfirmed), so it faces the
  // same gate. The difference is what a refusal means: a refused PUBLISH is an
  // error the seller must see, while a refused PREFILL falls back to the old
  // draft record rather than blocking a form that is already filled.
  let prefillListed = !published && PREFILL_RECORDS_AS_LISTED;
  if (published || prefillListed) {
    const capGate = await requireFlipdesk(c, {
      capacity: {
        kind: "activeListings",
        delta: item.status === "listed" ? 0 : 1,
      },
      userId: ownerId,
    });
    if (capGate) {
      if (published) return capGate;
      prefillListed = false;
    }
  }
  /** Whatever the path, does the row read `active` after this call? */
  const recordListed = published || prefillListed;
  const platformLabel = getMarketplaceSpec(platform)?.label ?? platform;
  /** One notice per transition into "listed" and one per confirmation. */
  const tell = (confirmed: boolean) =>
    void notifyExtensionListed(ownerId, {
      itemTitle: item.title,
      itemId,
      platformLabel,
      confirmed,
    });

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
    const wasActive = existing.listing_status === "active";
    const wasUnconfirmed = hasUnconfirmedMarker(existing.platform_fields);
    const patch = buildWritebackPatch({
      published,
      existingStatus: existing.listing_status,
      existingListedAt: existing.listed_at,
      listingUrl,
      groupId,
      now,
      prefillAsListed: prefillListed,
      existingPlatformFields: existing.platform_fields,
    });
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
    // US-2179: count a confirmed extension publish against the cap. US-3367:
    // and a prefill recorded as listed, which reads the same to the cap.
    if (recordListed) await markItemListed(itemId, ownerId);
    // Tell the seller once when the row becomes listed, and once more when an
    // unconfirmed record is confirmed. A re-confirmation of a confirmed row
    // says nothing.
    if (published && (!wasActive || wasUnconfirmed)) tell(true);
    else if (prefillListed && !wasActive) tell(false);
    return c.json({
      ok: true,
      listing_id: existing.id,
      platform,
      created: false,
      published: published || wasActive,
      recorded: published ? "confirmed" : recordListed ? "unconfirmed" : "draft",
    });
  }

  const { data: created, error: insErr } = await supabaseAdmin
    .from("listings")
    .insert({
      inventory_item_id: itemId,
      platform,
      // US-1077: recording a FlipDesk cross-listing → GradeThread-originated.
      listing_origin: "gradethread",
      // US-1877 (AC2) recorded 'draft' unless the seller had published; US-3367
      // records a filled form as 'active' with the unconfirmed marker (see the
      // top of this file). Either way it reuses the existing listing_status
      // enum ('draft','active','ended','sold','relisted' — 00008) rather than
      // minting a 'prefilled' one, so no migration.
      listing_status: recordListed ? "active" : "draft",
      is_active: recordListed,
      listing_price: price,
      listing_url: listingUrl,
      // A draft was never listed — a listed_at here is what made phantom rows look
      // like real, dateable cross-listings in the pipeline. A row recorded as
      // listed is being listed NOW.
      listed_at: recordListed ? now : null,
      platform_fields: prefillListed ? withUnconfirmedMarker(null, now) : undefined,
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
  // US-2179: count a confirmed extension publish against the cap. US-3367:
  // and a prefill recorded as listed.
  if (recordListed) {
    await markItemListed(itemId, ownerId);
    tell(published);
  }
  return c.json({
    ok: true,
    listing_id: (created as { id: string }).id,
    platform,
    created: true,
    published,
    recorded: published ? "confirmed" : recordListed ? "unconfirmed" : "draft",
  });
}

// ── US-3367: the opt-out ──────────────────────────────────────────────────────

export type NotListedOutcome = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * The seller says a row recorded as listed on an extension channel is not, in
 * fact, listed there. The row goes back to a draft, its URL and marker are
 * dropped, any pending delist stamp is cleared (there is nothing to end), and
 * the item's status is re-derived from whatever is still live.
 *
 * Extension channels only: an eBay or Shopify row's liveness is the API's to
 * say, and "Not listed" on one of those would be a lie the next sync undoes.
 *
 * TENANCY (US-268): the row is owner-checked before anything is written.
 */
export async function markNotListed(
  ownerId: string,
  listingId: string,
): Promise<NotListedOutcome> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select("id, platform, listing_status, inventory_item_id, platform_fields")
    .eq("id", listingId)
    .eq("user_id", ownerId) // US-268
    .maybeSingle();
  const row = data as
    | {
      id: string;
      platform: string;
      listing_status: string | null;
      inventory_item_id: string | null;
      platform_fields: Record<string, unknown> | null;
    }
    | null;
  if (!row) return { status: 404, body: { error: "Listing not found." } };
  if (delistMethodFor(row.platform) !== "extension") {
    return {
      status: 409,
      body: {
        error: `${getMarketplaceSpec(row.platform)?.label ?? row.platform} listings are ` +
          "tracked through its API, so FlipDesk cannot take a seller's word over it.",
      },
    };
  }
  if (row.listing_status === "sold") {
    return { status: 409, body: { error: "This listing has a recorded sale; it cannot be un-listed." } };
  }

  const cleared = withoutUnconfirmedMarker(row.platform_fields);
  const patch: Record<string, unknown> = {
    listing_status: "draft",
    is_active: false,
    listing_url: null,
    listed_at: null,
    delist_requested_at: null,
  };
  if (cleared) patch.platform_fields = cleared;
  const { error } = await supabaseAdmin
    .from("listings")
    .update(patch)
    .eq("id", row.id)
    .eq("user_id", ownerId); // US-268
  if (error) {
    console.error("[extension-writeback] not-listed update failed:", error.message);
    return { status: 500, body: { error: "Could not update the listing." } };
  }
  // Drafted again unless something else is live (US-2179 guard inside).
  await resyncItemListedStatus(row.inventory_item_id, ownerId);
  return { status: 200, body: { ok: true, listing_id: row.id, listing_status: "draft" } };
}

