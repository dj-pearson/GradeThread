import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import {
  type AdapterResult,
  type CrossListingPlatform,
  isCrossListingPlatform,
  resolveAdapter,
} from "../lib/marketplace-adapters/index.ts";
import {
  getMarketplaceSpec,
  type MarketplacePlatform,
} from "../lib/marketplace-specs.ts";
import type { StoredPlatformVariant } from "../lib/cross-listing-fields.ts";
import { generatePlatformVariants } from "../lib/ai-listing.ts";
import { withAiAction } from "../lib/ai-metering.ts";
import { checkQuota } from "./flipdesk-ai.ts";
import {
  crossPushPlatform,
  ensureCrossListingGroup,
} from "../lib/cross-push.ts";
import { delistMethodFor } from "../lib/cross-listing-sale.ts";
import { loadPendingDelists } from "../lib/pending-delists.ts";
import { loadTitleConflictBaseDraft } from "../lib/title-conflict-base-draft.ts";
import { readVariantWinnerForOwner } from "../lib/title-variant-ctr.ts";
import { fetchComparableListings, findDuplicateTitles } from "../lib/title-similarity.ts";
import {
  isNoEbayConnectionError,
  isOfferAlreadyEndedError,
} from "../lib/ebay-client.ts";
import {
  type BulkEditPatch,
  type LoadedListing,
  MAX_BULK_EDIT_ITEMS,
  normalizeBulkEdit,
  normalizeBulkEditItems,
  processBulkEdit,
  summarizeBulkEdit,
} from "../lib/bulk-listing-edit.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { deriveListingOrigin } from "../lib/sync-precedence.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { markItemListed } from "../lib/active-listings.ts";
// US-2166: the platform-agnostic lifecycle core, shared with the
// eBay-namespaced routes so price and end have exactly ONE implementation.
import { resyncItemListedStatus } from "../lib/active-listings.ts";
import {
  applyListingPrice,
  endLocally,
  endOwnedListing,
  loadOwnedListing,
  originLockResponse,
  platformName,
  pushPriceUpstream,
  liveBlockReason,
  wasPublishedUpstream,
} from "../lib/listing-lifecycle.ts";

// Multi-marketplace cross-listing dispatch (US-149 + US-564).
//
// POST /cross-push fans a single source draft out into one listings row per
// selected platform (denormalized; siblings share listings.draft_id), then
// asks each platform's adapter to publish. eBay (US-121) and Shopify (US-599,
// the first first-class non-eBay target) publish for real; Depop (US-714) is
// wired but gated until platform approval. Any adapter that isn't live yet
// returns a typed 501, leaving its row a local draft.
//
// US-564 (AC3): each non-eBay sibling is populated from its per-marketplace AI
// variant (US-721 platform_fields) — title/description clamped to that
// platform's limits, with condition/category/tags carried through — rather than
// a verbatim copy of the eBay draft. Missing variants are generated on demand.

export const flipdeskListingsRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

interface SourceDraftRow {
  id: string;
  inventory_item_id: string;
  platform: string;
  draft_id: string | null;
  listing_price: number;
  listing_title: string | null;
  listing_description: string | null;
  primary_photo_id: string | null;
  inventory_items: {
    user_id: string;
    target_price: number | null;
    // US-2179: needed to size the activeListings cap delta (see the gate in
    // /cross-push) — an item already live somewhere doesn't consume a new slot.
    status: string | null;
  };
}

interface PlatformPushResult {
  ok: boolean;
  status?: number;
  error?: string;
  blockers?: string[];
  listing_row_id: string;
  platform_listing_id?: string;
  listing_url?: string;
  price: number;
}

// Resolves the per-marketplace AI field variants (US-721) for the requested
// non-eBay platforms. Reads them off the item's eBay base draft
// (listings.platform_fields); any platform without a variant yet is generated
// on demand (best-effort — a failure just falls back to the source-draft copy
// so cross-push never blocks on AI). Tenant-scoped: generatePlatformVariants
// re-loads the item + draft by ownerId.
async function resolvePlatformVariants(
  ownerId: string,
  itemId: string,
  platforms: CrossListingPlatform[],
): Promise<Record<string, StoredPlatformVariant>> {
  const mapped = platforms.filter(
    (p) => p !== "ebay" && getMarketplaceSpec(p),
  ) as MarketplacePlatform[];
  if (mapped.length === 0) return {};

  const read = async (): Promise<Record<string, StoredPlatformVariant>> => {
    const { data } = await supabaseAdmin
      .from("listings")
      .select("platform_fields")
      .eq("inventory_item_id", itemId)
      .eq("platform", "ebay")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (
      (data as { platform_fields: Record<string, StoredPlatformVariant> | null } | null)
        ?.platform_fields ?? {}
    );
  };

  let fields = await read();
  const missing = mapped.filter((p) => !fields[p]);
  if (missing.length > 0) {
    try {
      // US-1581: one billed action for the lazy fill, reserved atomically
      // BEFORE the model call (the old meter-after had no cap check). A cap
      // or enablement refusal falls through to the source-copy fallback —
      // cross-push itself must never block on AI.
      const quota = await checkQuota(ownerId);
      if (!quota.ok) throw new Error("AI quota unavailable for lazy variant fill");
      await withAiAction(ownerId, quota.limit, () =>
        generatePlatformVariants(itemId, ownerId, missing));
      fields = await read();
    } catch (err) {
      console.warn(
        "[cross-push] per-platform field mapping unavailable, using source copy:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return fields;
}

function toPushResult(
  res: AdapterResult,
  listingRowId: string,
  price: number,
): PlatformPushResult {
  if (res.ok) {
    return {
      ok: true,
      listing_row_id: listingRowId,
      platform_listing_id: res.platformListingId,
      listing_url: res.listingUrl,
      price,
    };
  }
  return {
    ok: false,
    status: res.status,
    error: res.error,
    blockers: res.blockers,
    listing_row_id: listingRowId,
    price,
  };
}

flipdeskListingsRoutes.post("/cross-push", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: {
    listing_id?: unknown;
    platforms?: unknown;
    prices?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const listingId = typeof body.listing_id === "string" ? body.listing_id : "";
  if (!listingId) {
    return c.json({ error: "listing_id is required." }, 400);
  }
  if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
    return c.json({ error: "platforms must be a non-empty array." }, 400);
  }
  const platforms: CrossListingPlatform[] = [];
  for (const p of body.platforms) {
    if (typeof p !== "string" || !isCrossListingPlatform(p)) {
      return c.json(
        { error: `Unsupported platform: ${String(p)}.` },
        400,
      );
    }
    if (!platforms.includes(p)) platforms.push(p);
  }
  const rawPrices =
    body.prices && typeof body.prices === "object"
      ? (body.prices as Record<string, unknown>)
      : {};

  // Load the source draft and verify the caller owns it (US-268 — the
  // service-role client bypasses RLS, so ownership must be explicit).
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform, draft_id, listing_price, listing_title, " +
        "listing_description, primary_photo_id, " +
        "inventory_items!inner(user_id, target_price, status)",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (error) {
    return c.json({ error: "Could not load the listing." }, 500);
  }
  const maybeDraft = data as unknown as SourceDraftRow | null;
  if (!maybeDraft || maybeDraft.inventory_items.user_id !== ownerId) {
    return c.json({ error: "Listing not found." }, 404);
  }
  const draft = maybeDraft;

  // US-2179: enforce the active-listing cap here too. Cross-push publishes to
  // real marketplaces, so it consumes a cap slot exactly like the eBay push
  // (flipdesk-ebay /listings/push) — but it never checked, which is how a Free
  // account could put unlimited items live on Depop/Etsy/Shopify/Whatnot. Same
  // delta rule as the eBay gate: an item already live somewhere occupies its
  // slot already, so a fan-out to a SECOND channel adds nothing to the count
  // (the cap counts live ITEMS, not listing rows).
  const capGate = await requireFlipdesk(c, {
    capacity: {
      kind: "activeListings",
      delta: draft.inventory_items.status === "listed" ? 0 : 1,
    },
    userId: ownerId,
  });
  if (capGate) return capGate;

  // The group key is the source draft's own id; the source row points at
  // itself so every member of the group (including the source) is found with
  // one draft_id lookup.
  const groupId = await ensureCrossListingGroup(
    ownerId,
    draft.id,
    draft.draft_id,
  );
  if (!groupId) {
    return c.json({ error: "Could not start the cross-listing group." }, 500);
  }

  function priceFor(platform: CrossListingPlatform): number {
    const raw = rawPrices[platform];
    const explicit = typeof raw === "number" && isFinite(raw) && raw > 0
      ? raw
      : null;
    // Default per the story: the draft's price (itself seeded from the item's
    // target price in the composer), then the item's target price.
    const target = draft.inventory_items.target_price;
    return explicit ??
      (draft.listing_price > 0
        ? draft.listing_price
        : target != null && target > 0
        ? target
        : 0);
  }

  // US-564 (AC3): resolve the per-marketplace field variants once for the whole
  // fan-out (one AI pass covers every missing platform).
  const variantMap = await resolvePlatformVariants(
    ownerId,
    draft.inventory_item_id,
    platforms,
  );

  const results: Partial<Record<CrossListingPlatform, PlatformPushResult>> = {};

  for (const platform of platforms) {
    const price = priceFor(platform);
    // US-2156: the per-platform slice moved to lib/cross-push.ts so the
    // crosslist_to automation action publishes through the exact same path a
    // human cross-push does — find-or-create the sibling row, map it onto the
    // platform's limits, pre-flight it, publish.
    const { result, listingRowId } = await crossPushPlatform({
      ownerId,
      draft,
      groupId,
      platform,
      price,
      variant: variantMap[platform],
    });
    results[platform] = toPushResult(result, listingRowId, price);
  }

  // US-2179: one successful publish anywhere makes the item live, so advance it
  // to 'listed' — once for the whole fan-out. Previously only the eBay paths did
  // this, so a Depop/Etsy/Shopify/Whatnot listing was invisible to both the
  // activeListings cap and the usage meter. If every platform failed the item
  // stays a draft, matching what actually happened.
  if (Object.values(results).some((r) => r?.ok)) {
    await markItemListed(draft.inventory_item_id, ownerId);
  }

  return c.json({ ok: true, draft_id: groupId, results });
});

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

flipdeskListingsRoutes.post("/extension-writeback", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: {
    item_id?: unknown;
    platform?: unknown;
    listing_url?: unknown;
    published?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

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
    .select("id, listing_status, listing_url, listed_at")
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
    }
    | null;
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
});

// ── US-717: extension auto-delist queue ───────────────────────────────────
//
// When a cross-listed item sells, auto-end (cross-listings.ts) ends the API
// siblings via their delist API but can only QUEUE the extension siblings
// (Poshmark/Mercari/Grailed) — those have no write API and live in the seller's
// own browser. It stamps listings.delist_requested_at; the SaaS surface reads
// the queue here, the GradeThread Lister extension ends each listing in the
// seller's own tab, then the SaaS confirms back to clear the stamp.


// GET /pending-delists — extension siblings still awaiting an end on their
// marketplace. Tenant-scoped via inventory_items.user_id (US-268).
//
// The query + projection live in lib/pending-delists.ts because the extension
// popup reads the same queue over a different auth dialect (US-1885 AC1). Two
// copies would eventually disagree about `auto_delistable`, and the failure is
// silent: one surface offers a one-click end for a listing the other knows it
// cannot end, so the seller is told it was handled while it stays live.
// GET /title-conflicts/:itemId — US-2677 (AC3).
//
// The composer needs the duplicate finding while the seller is still WRITING
// the title, and the full publish preflight is the wrong tool for that: it
// resolves business policies, probes the category tree and talks to eBay, none
// of which has anything to say about whether two of your own titles read alike.
// This runs the one check.
//
// Tenant-scoped twice over: the listing is loaded by item id filtered on the
// resolved owner, and fetchComparableListings filters again on the same id.
flipdeskListingsRoutes.get("/title-conflicts/:itemId", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const itemId = c.req.param("itemId");
  if (!itemId) return c.json({ error: "itemId is required" }, 400);

  // US-2728: ONE row, and it must be the eBay base draft. The query and the
  // reasoning behind it live in lib/title-conflict-base-draft.ts, where a test
  // can reproduce the two-row case that broke this route in production.
  const { row, error } = await loadTitleConflictBaseDraft(ownerId, itemId);
  if (error) {
    return failSafe(c, 500, "Could not check for similar listings.", error, "flipdesk.title-conflicts");
  }
  // No draft yet, or no category chosen yet, means nothing defensible to
  // compare against. An empty list, not an error: the composer asks for this on
  // every item and most items have no conflict.
  if (!row?.listing_title || !row.platform_category_id) {
    return c.json({ ok: true, conflicts: [] });
  }

  const others = await fetchComparableListings(ownerId, row.platform_category_id, row.id);
  return c.json({ ok: true, conflicts: findDuplicateTitles(row.listing_title, others) });
});

// GET /title-variants — US-2676. Which title wording is winning the click.
//
// Tenant-scoped through readVariantWinnerForOwner, which filters BOTH
// listing_metrics and listings on the resolved owner id (US-268). The route
// takes no id from the caller at all: there is nothing here to point at
// somebody else's data with.
//
// Returns a STATE rather than a nullable winner. For most sellers most of the
// time the honest answer is "not enough exposure yet", and a null would make
// that indistinguishable from a tie.
flipdeskListingsRoutes.get("/title-variants", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const readout = await readVariantWinnerForOwner(ownerId);
    return c.json({ ok: true, readout });
  } catch (err) {
    return failSafe(
      c,
      500,
      "Could not load title variant performance.",
      err,
      "flipdesk.title-variants",
    );
  }
});

flipdeskListingsRoutes.get("/pending-delists", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { pending, error } = await loadPendingDelists(ownerId);
  if (error) {
    return failSafe(c, 500, "Could not load pending delists.", error, "flipdesk.pending-delists");
  }
  return c.json({ ok: true, pending });
});

// POST /delist-confirm — the extension ended the listing on the marketplace (or
// the seller did manually); clear the queue stamp. Tenant-scoped: ownership of
// the listing's parent item is verified before the write (US-268).
flipdeskListingsRoutes.post("/delist-confirm", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { listing_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const listingId = typeof body.listing_id === "string" ? body.listing_id : "";
  if (!listingId) return c.json({ error: "listing_id is required." }, 400);

  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("id, inventory_item_id, inventory_items!inner(user_id)")
    .eq("id", listingId)
    .maybeSingle();
  if (error) return c.json({ error: "Could not load the listing." }, 500);
  const row = data as {
    id: string;
    inventory_item_id: string | null;
    inventory_items: { user_id: string };
  } | null;
  if (!row || row.inventory_items.user_id !== ownerId) {
    return c.json({ error: "Listing not found." }, 404);
  }

  const { error: upErr } = await supabaseAdmin
    .from("listings")
    .update({
      delist_requested_at: null,
      listing_status: "ended",
      is_active: false,
    })
    .eq("id", listingId);
  if (upErr) return c.json({ error: "Could not confirm the delist." }, 500);
  // US-2179: release the item's activeListings slot once nothing is live. This
  // route never touched the item status, so an item whose only listing was an
  // extension sibling would have stayed 'listed' forever — holding a cap slot
  // the seller had already given up.
  await resyncItemListedStatus(row.inventory_item_id, ownerId);
  return c.json({ ok: true, listing_id: listingId });
});

// Hard-delete an inventory item and everything that cascades from it (its
// listings, item_photos, autolister jobs, …). Used to remove a DUPLICATE the
// seller never wants — distinct from End (which withdraws the eBay offer but
// keeps the item as a draft) and Archive (a status change that keeps the row).
//
// TWO GUARDS make this safe (both cascade FKs would otherwise silently destroy
// real records):
//   • a LIVE listing → refuse; deleting the item would orphan a live eBay
//     listing buyers can still purchase. End it first.
//   • any SALE → refuse; sales ON DELETE CASCADE and are accounting records.
//     Archive the item instead.
//
// SECURITY (US-268): the item is loaded AND deleted scoped to the owner
// (workspaceOwnerId ?? userId) — an id from the request alone never deletes
// another tenant's row.
flipdeskListingsRoutes.delete("/item/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
  const itemId = c.req.param("id");
  if (!itemId) return c.json({ error: "item id is required" }, 400);

  const { data: item } = await supabaseAdmin
    .from("inventory_items")
    .select("id, title")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!item) return c.json({ error: "Item not found." }, 404);

  // GUARD 1: a genuinely LIVE listing must be ended first (never orphan a live
  // marketplace offer). "Live" keys off the lifecycle STATUS + whether it was
  // actually published. This still reads listing_status directly rather than the
  // is_active mirror (US-2176 made it a lockstep mirror of the status, so a draft
  // is now correctly is_active=false) because the published-DRAFT case below —
  // a row still in 'draft' status that nonetheless reached the marketplace — is
  // live yet is_active=false, so is_active alone would under-report it.
  const { data: listings } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform, listing_status, listing_url, platform_offer_id, " +
        "platform_listing_id, synced_to_ebay_at",
    )
    .eq("inventory_item_id", itemId);
  type DeleteBlockRow = {
    id: string;
    platform: string | null;
    listing_status: string | null;
    listing_url: string | null;
    platform_offer_id: string | null;
    platform_listing_id: string | null;
    synced_to_ebay_at: string | null;
  };
  // US-2657: WHICH listing blocks, and why. The refusal used to be one sentence
  // with no subject — "This item has a live listing" — which is unactionable
  // precisely when it is most confusing: the seller is looking at a page that
  // says DRAFT. A stale published-draft row and a genuinely live listing produce
  // the identical message, and the two need opposite responses (end it vs.
  // realise the row is pointing at something else). So name it.
  const blocking = ((listings ?? []) as unknown as DeleteBlockRow[])
    .map((row) => ({ row, reason: liveBlockReason(row) }))
    .filter((b): b is { row: DeleteBlockRow; reason: NonNullable<ReturnType<typeof liveBlockReason>> } =>
      b.reason !== null
    );
  if (blocking.length > 0) {
    const blockingListings = blocking.map(({ row, reason }) => ({
      listing_id: row.id,
      platform: row.platform ?? "ebay",
      listing_status: row.listing_status,
      listing_url: row.listing_url,
      platform_listing_id: row.platform_listing_id,
      reason,
    }));
    // The published-draft case is the one worth spelling out. The seller's screen
    // says draft, so "end the listing first" reads as nonsense until they know we
    // are talking about a row that reached the marketplace and never came back.
    const anyPublishedDraft = blocking.some((b) => b.reason === "published_draft");
    const names = blockingListings
      .map((b) => `${b.platform} (${b.listing_status ?? "no status"})`)
      .join(", ");
    return c.json({
      error: anyPublishedDraft
        ? `This item is still linked to a listing that reached the marketplace: ` +
          `${names}. It shows as a draft here, but it was published at some point ` +
          `and never ended, so deleting the item would orphan it. End that listing ` +
          `first — or if it belongs to a different item, unlink it there.`
        : `This item has a live listing: ${names}. End the listing first, then delete it.`,
      code: "has_live_listing",
      blocking_listings: blockingListings,
    }, 409);
  }

  // GUARD 2: never cascade-delete a sale (accounting record).
  const { count: saleCount } = await supabaseAdmin
    .from("sales")
    .select("id", { count: "exact", head: true })
    .eq("inventory_item_id", itemId);
  if ((saleCount ?? 0) > 0) {
    return c.json({
      error:
        "This item has sales history and can't be deleted. Archive it instead.",
      code: "has_sales",
    }, 409);
  }

  // Best-effort: remove the item's photo objects so the delete doesn't orphan
  // files in the item-photos bucket (the item_photos ROWS cascade with the item).
  const { data: photos } = await supabaseAdmin
    .from("item_photos")
    .select("storage_path, thumbnail_storage_path")
    .eq("inventory_item_id", itemId);
  const paths = ((photos ?? []) as Array<{
    storage_path: string | null;
    thumbnail_storage_path: string | null;
  }>)
    .flatMap((p) => [p.storage_path, p.thumbnail_storage_path])
    .filter((p): p is string => !!p);
  if (paths.length > 0) {
    const { error: rmErr } = await supabaseAdmin.storage
      .from("item-photos")
      .remove(paths);
    if (rmErr) {
      // Non-fatal: an orphaned object is cosmetic; still delete the row.
      console.warn(
        "[flipdesk-listings] delete: photo storage cleanup failed (non-fatal):",
        rmErr.message,
      );
    }
  }

  const { error: delErr } = await supabaseAdmin
    .from("inventory_items")
    .delete()
    .eq("id", itemId)
    .eq("user_id", ownerId);
  if (delErr) {
    console.error("[flipdesk-listings] delete item failed:", delErr.message);
    return c.json({ error: "Delete failed. Please try again." }, 500);
  }
  return c.json({ ok: true, item_id: itemId });
});

// ── US-2166: the PLATFORM-AGNOSTIC listing lifecycle ──────────────────────
//
// Price and End used to exist only as /api/flipdesk/ebay/listings/:id/{price},
// DELETE /api/flipdesk/ebay/listings/:id — and both hardcoded `platform: "ebay"`
// when deriving the row's provenance. The frontend consequence (US-2162 /
// US-2163) was severe: those endpoints 409 on a non-eBay row (no
// platform_offer_id), the UI caught the 409 and wrote the local `listings` row
// directly, and the seller was told "Listing ended locally." / "(N updated
// locally only)" while the listing stayed LIVE and purchasable on Shopify, Etsy
// or Depop. A local row diverged from the marketplace is the same oversell class
// US-1877 and US-2165 close from their own directions.
//
// These routes dispatch on the row's REAL platform:
//   • eBay      → the cheap targeted eBay calls (updateOfferPrice / the offer
//                 withdraw), preserving the behaviour the eBay routes have today
//                 rather than paying for a full re-publish to change a price.
//   • any other → that platform's adapter (updateListing / delist).
//
// The eBay-namespaced routes are deliberately LEFT IN PLACE: shipped iOS and
// Android builds and the browser extension call those paths, and a client we
// can't redeploy must keep working (see the US-2166 story note).
//
// SECURITY (US-268): every handler resolves the listing through
// loadOwnedListing, which filters on inventory_items.user_id. An id from the
// request never reaches a write without that check.

// POST /:id/price — reprice ONE listing on its own marketplace.
// The work lives in lib/listing-lifecycle.ts so the eBay-namespaced route below
// can share it rather than keep a second copy (US-2166).
flipdeskListingsRoutes.post("/:id/price", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  if (!listingId) return c.json({ error: "listing id is required." }, 400);

  let body: { price?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return c.json({ error: "price must be a positive number." }, 400);
  }

  const res = await applyListingPrice(ownerId, listingId, price);
  if (!res.ok) {
    return c.json(
      res.status === 409 && res.lockedFields
        ? { error: res.error, locked_fields: res.lockedFields }
        : { error: res.error },
      res.status,
    );
  }
  return c.json({
    ok: true,
    listing_id: listingId,
    price: res.price,
    pushed: res.pushed,
  });
});

// POST /:id/end — end ONE listing on its own marketplace.
//
// The contract that matters: the local row is marked ended ONLY when the listing
// is genuinely not live any more. A failed delist returns an error and leaves the
// row active, because telling a seller an item is ended while buyers can still
// buy it is worse than telling them the end failed.
flipdeskListingsRoutes.post("/:id/end", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  if (!listingId) return c.json({ error: "listing id is required." }, 400);

  // US-9129: the body lives in lib/listing-lifecycle.ts, next to
  // applyListingPrice, so the connector's end tool calls the same path. The
  // status/body pair is what this handler used to build inline.
  const outcome = await endOwnedListing(ownerId, listingId);
  return c.json(outcome.body, outcome.status as 200);
});


// POST /bulk-price — US-2163: reprice a SELECTION in one request.
//
// Replaces a browser loop that fired one HTTP call per selected listing (200
// listings = 200 round trips under a blocking spinner with no cancel), and whose
// 409 branch quietly wrote the local price for every non-eBay row and reported it
// as "updated locally only".
//
// Two shapes, because the UI needs both: an explicit `price` for every id, or a
// `drop_pct` the SERVER applies to each row's current price. drop_pct is computed
// server-side deliberately — the client would otherwise have to hold a price per
// row and could send a figure derived from a stale render.
//
// Per-row results come back structured. A row whose marketplace refused is
// reported FAILED with its reason, and its local price is left alone; there is no
// "succeeded locally" state, because that state is what made the numbers lie.
flipdeskListingsRoutes.post("/bulk-price", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  // Bulk multi-listing actions are a Pro+ feature (US-208), same gate as
  // /listings/bulk-edit.
  const gate = await requireFlipdesk(c, { feature: "bulkActions", userId: ownerId });
  if (gate) return gate;

  let body: {
    listing_ids?: unknown;
    price?: unknown;
    drop_pct?: unknown;
    items?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  // US-2172: the third shape — a PER-ROW price. This is what makes a bulk
  // reprice reversible: the response already returns each row's previous_price,
  // so undo is the same endpoint called back with those pairs. A single shared
  // price or percentage cannot express "put each of these 200 listings back to
  // its own former number".
  const perRow = new Map<string, number>();
  if (body.items !== undefined) {
    if (!Array.isArray(body.items)) {
      return c.json({ error: "items must be an array." }, 400);
    }
    for (const raw of body.items) {
      const entry = raw as { listing_id?: unknown; price?: unknown } | null;
      const id = typeof entry?.listing_id === "string" ? entry.listing_id : "";
      const price = Number(entry?.price);
      if (!id) return c.json({ error: "Each item needs a listing_id." }, 400);
      if (!Number.isFinite(price) || price <= 0) {
        return c.json(
          { error: `Each item needs a positive price (listing ${id}).` },
          400,
        );
      }
      perRow.set(id, price);
    }
    if (perRow.size === 0) return c.json({ error: "items was empty." }, 400);
  }

  // With `items`, the id list comes from the entries themselves — a caller
  // shouldn't have to send the same ids twice and risk the two disagreeing.
  const ids = perRow.size > 0
    ? [...perRow.keys()]
    : Array.isArray(body.listing_ids)
    ? [...new Set(body.listing_ids.filter((x): x is string => typeof x === "string"))]
    : [];
  if (ids.length === 0) {
    return c.json({ error: "listing_ids or items is required." }, 400);
  }
  if (ids.length > MAX_BULK_EDIT_ITEMS) {
    return c.json({ error: `Too many listings (max ${MAX_BULK_EDIT_ITEMS}).` }, 400);
  }

  const explicitPrice = body.price === undefined ? null : Number(body.price);
  const dropPct = body.drop_pct === undefined ? null : Number(body.drop_pct);
  if (perRow.size === 0 && explicitPrice === null && dropPct === null) {
    return c.json({ error: "Provide items, price, or drop_pct." }, 400);
  }
  if (explicitPrice !== null && (!Number.isFinite(explicitPrice) || explicitPrice <= 0)) {
    return c.json({ error: "price must be a positive number." }, 400);
  }
  if (dropPct !== null && (!Number.isFinite(dropPct) || dropPct <= 0 || dropPct >= 100)) {
    return c.json({ error: "drop_pct must be between 0 and 100." }, 400);
  }

  interface RowResult {
    listing_id: string;
    ok: boolean;
    price?: number;
    previous_price?: number | null;
    pushed?: boolean;
    error?: string;
  }
  const results: RowResult[] = [];

  // Sequential on purpose: each row can hit a marketplace API, and the eBay
  // per-offer calls are rate-limited. Bounded by MAX_BULK_EDIT_ITEMS.
  for (const id of ids) {
    const row = await loadOwnedListing(id, ownerId);
    if (!row) {
      results.push({ listing_id: id, ok: false, error: "Listing not found." });
      continue;
    }

    const lock = originLockResponse(row, ["listing_price"]);
    if (lock.locked) {
      results.push({
        listing_id: id,
        ok: false,
        error: "eBay owns this listing's price — reprice it on eBay.",
      });
      continue;
    }

    let next: number;
    const rowPrice = perRow.get(id);
    if (rowPrice !== undefined) {
      // US-2172: per-row price (the undo shape) wins — it is the most specific
      // instruction the caller gave.
      next = rowPrice;
    } else if (explicitPrice !== null) {
      next = explicitPrice;
    } else {
      const current = row.listing_price;
      if (current == null || current <= 0) {
        results.push({
          listing_id: id,
          ok: false,
          error: "No current price to apply a percentage drop to.",
        });
        continue;
      }
      next = Number((current * (1 - dropPct! / 100)).toFixed(2));
      if (next <= 0) {
        results.push({
          listing_id: id,
          ok: false,
          error: "That drop would take the price to zero.",
        });
        continue;
      }
    }

    const previous = row.listing_price;

    // A never-published draft has no marketplace to push to — the local write IS
    // the whole operation, and saying so (pushed:false) is not the same as
    // claiming a live listing was repriced.
    if (!wasPublishedUpstream(row)) {
      const { error: draftErr } = await supabaseAdmin
        .from("listings")
        .update({ listing_price: next })
        .eq("id", id);
      if (draftErr) {
        results.push({ listing_id: id, ok: false, error: "Could not save the price." });
        continue;
      }
      results.push({
        listing_id: id,
        ok: true,
        price: next,
        previous_price: previous,
        pushed: false,
      });
      continue;
    }

    // Push FIRST, then record — same ordering as the single-listing route, so a
    // refused row keeps the price the marketplace actually has.
    const failure = await pushPriceUpstream(ownerId, row, next);
    if (failure) {
      results.push({ listing_id: id, ok: false, error: failure.error });
      continue;
    }

    const { error: writeErr } = await supabaseAdmin
      .from("listings")
      .update({ listing_price: next })
      .eq("id", id);
    if (writeErr) {
      console.error("[flipdesk-listings] bulk price pushed but local write failed:", writeErr.message);
      results.push({
        listing_id: id,
        ok: false,
        error: "Price is live on the marketplace but our copy didn't update.",
      });
      continue;
    }

    if (row.inventory_item_id) {
      await supabaseAdmin
        .from("inventory_items")
        .update({ target_price: next })
        .eq("id", row.inventory_item_id)
        .eq("user_id", ownerId);
    }
    results.push({
      listing_id: id,
      ok: true,
      price: next,
      previous_price: previous,
      pushed: true,
    });
  }

  const succeeded = results.filter((r) => r.ok).length;
  return c.json({
    ok: true,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  });
});

// POST /bulk-end — US-2162: end a SELECTION, each on its own marketplace.
//
// Same story as /bulk-price: the browser looped one call per listing and, on the
// 409 that every non-eBay row produced, wrote listing_status:'ended' locally and
// reported "(N ended locally only)". Those listings stayed live. At selection
// sizes past ~30 the loop also tripped this router's rate limit, so a large bulk
// end silently half-finished.
//
// Per-row results, and a row that could NOT be ended upstream is reported FAILED
// with its local status untouched — an item that is still for sale must keep
// looking like it is still for sale.
flipdeskListingsRoutes.post("/bulk-end", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const gate = await requireFlipdesk(c, { feature: "bulkActions", userId: ownerId });
  if (gate) return gate;

  let body: { listing_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const ids = Array.isArray(body.listing_ids)
    ? [...new Set(body.listing_ids.filter((x): x is string => typeof x === "string"))]
    : [];
  if (ids.length === 0) return c.json({ error: "listing_ids is required." }, 400);
  if (ids.length > MAX_BULK_EDIT_ITEMS) {
    return c.json({ error: `Too many listings (max ${MAX_BULK_EDIT_ITEMS}).` }, 400);
  }

  interface EndRowResult {
    listing_id: string;
    ok: boolean;
    ended_upstream?: boolean;
    already_ended?: boolean;
    /** US-2162: queued for the Lister extension; still live until it runs. */
    queued?: boolean;
    error?: string;
  }
  const results: EndRowResult[] = [];

  for (const id of ids) {
    const row = await loadOwnedListing(id, ownerId);
    if (!row) {
      results.push({ listing_id: id, ok: false, error: "Listing not found." });
      continue;
    }
    if (row.listing_status === "ended" || row.listing_status === "sold") {
      results.push({ listing_id: id, ok: true, already_ended: true });
      continue;
    }
    if (!wasPublishedUpstream(row)) {
      await endLocally(id, row.inventory_item_id, ownerId);
      results.push({ listing_id: id, ok: true, ended_upstream: false });
      continue;
    }

    // US-2162 (AC3): same planner as the single end and as
    // autoEndCrossListings, so a bulk end can't reach a different verdict about
    // a marketplace than the two other paths that end the same listing.
    const method = delistMethodFor(row.platform ?? "");
    if (method === "extension") {
      const { error: stampErr } = await supabaseAdmin
        .from("listings")
        .update({ delist_requested_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", ownerId); // US-268
      if (stampErr) {
        results.push({
          listing_id: id,
          ok: false,
          error:
            `We couldn't queue this ${platformName(row.platform)} listing to be ended — it's still live.`,
        });
        continue;
      }
      await endLocally(id, row.inventory_item_id, ownerId);
      // ended_upstream stays false: it is NOT off the marketplace yet.
      results.push({ listing_id: id, ok: true, ended_upstream: false, queued: true });
      continue;
    }

    const adapter = method === "unsupported"
      ? null
      : resolveAdapter(row.platform ?? "");
    if (!adapter) {
      results.push({
        listing_id: id,
        ok: false,
        error: `${platformName(row.platform)} listings can't be ended from GradeThread.`,
      });
      continue;
    }

    try {
      const res = await adapter.delist({
        ownerId,
        listingRowId: row.id,
        platformOfferId: row.platform_offer_id,
        platformListingId: row.platform_listing_id,
        // US-2166: same as the single end — an eBay variation listing has no
        // offer id and ends by group key.
        variations: row.variations,
        itemSku: row.item_sku,
        // US-1507: same as the single end — the publishing account.
        connectionId: row.marketplace_connection_id,
      });
      if (!res.ok) {
        results.push({ listing_id: id, ok: false, error: res.error });
        continue;
      }
    } catch (err) {
      if (isOfferAlreadyEndedError(err)) {
        await endLocally(id, row.inventory_item_id, ownerId);
        results.push({ listing_id: id, ok: true, ended_upstream: false });
        continue;
      }
      if (isNoEbayConnectionError(err)) {
        results.push({
          listing_id: id,
          ok: false,
          error: "Your eBay account isn't connected — the listing is still live.",
        });
        continue;
      }
      console.error("[flipdesk-listings] bulk-end delist threw:", err);
      results.push({
        listing_id: id,
        ok: false,
        error: `${platformName(row.platform)} couldn't end this listing — it's still live.`,
      });
      continue;
    }

    await endLocally(id, row.inventory_item_id, ownerId);
    results.push({ listing_id: id, ok: true, ended_upstream: true });
  }

  const succeeded = results.filter((r) => r.ok).length;
  return c.json({
    ok: true,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  });
});

// ── POST /bulk-edit (US-1292, moved here by US-2166) ────────────────
// Multi-select bulk edit of shared fields (price, quantity, condition, business
// policies, category) across connected marketplaces via the adapter
// abstraction. Tenant-scoped (US-268); respects field-ownership locks on
// marketplace-originated listings (US-1080 — never overwrites eBay-owned fields
// on an eBay-originated listing); bounded by MAX_BULK_EDIT_ITEMS. Reports a
// per-item outcome (ok | blocked | error) so a partial-failure batch is legible.
//
// Exported so the retired /api/flipdesk/ebay/listings/bulk-edit path can forward
// to it for shipped clients instead of keeping a second copy.
// The context is loosely typed on purpose: this one handler is mounted on TWO
// Hono instances whose generic Env types differ (the eBay router carries extra
// variables), and a narrow signature would reject one of them. It reads only
// the two variables both routers set, both guaranteed by the shared auth +
// workspace middleware.
// deno-lint-ignore no-explicit-any
export const bulkEditListingsHandler = async (c: Context<any>) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  // Bulk multi-listing actions are a Pro+ feature (US-208).
  const gate = await requireFlipdesk(c, { feature: "bulkActions", userId });
  if (gate) return gate;
  let body: { listing_ids?: unknown; edit?: unknown; items?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // US-2172: TWO body shapes. The original `listing_ids` + one shared `edit`,
  // and `items: [{ listing_id, edit }]` where each row carries its own patch.
  // Undo requires the second: reversing a bulk edit means putting every listing
  // back to ITS former value, which no single shared patch can express.
  const perItem = body.items !== undefined ? normalizeBulkEditItems(body.items) : null;
  if (body.items !== undefined && !perItem) {
    return c.json({ error: "items must be a non-empty array of { listing_id, edit }." }, 400);
  }

  const ids = perItem
    ? perItem.ids
    : Array.isArray(body.listing_ids)
    ? [...new Set(body.listing_ids.filter((x): x is string => typeof x === "string"))]
    : [];
  if (ids.length === 0) return c.json({ error: "listing_ids required" }, 400);
  if (ids.length > MAX_BULK_EDIT_ITEMS) {
    return c.json({ error: `Too many listings (max ${MAX_BULK_EDIT_ITEMS}).` }, 400);
  }

  const patch = perItem ? null : normalizeBulkEdit(body.edit as Record<string, unknown> | null);
  if (!perItem && !patch) return c.json({ error: "No valid fields to edit." }, 400);
  /** The patch this listing gets — its own under `items`, else the shared one. */
  const patchFor = (id: string): BulkEditPatch =>
    perItem ? (perItem.patchById.get(id) ?? {}) : patch!;
  const fieldNames = (id: string) => Object.keys(patchFor(id));
  /** Every column any row in this batch touches — what the prior-value read needs. */
  const allFields = [...new Set(ids.flatMap(fieldNames))];

  // Load only the caller's listings (tenant-scoped via the parent item owner).
  const { data: rows } = await supabaseAdmin
    .from("listings")
    // US-2172: the editable columns come back too, so the response can hand the
    // caller each row's PRIOR value and an undo can put it back. Read from the
    // same snapshot the write is planned against — re-reading afterwards would
    // return the value we just wrote.
    .select(
      "id, platform, platform_offer_id, platform_listing_id, listing_origin, batch_id, synced_to_ebay_at, listing_price, quantity, ebay_condition, ebay_condition_description, shipping_policy_id, payment_policy_id, return_policy_id, platform_category_id, inventory_item_id, inventory_items!inner(user_id)",
    )
    .in("id", ids)
    .eq("inventory_items.user_id", userId);
  type OwnedListingRow = {
    id: string;
    platform: string | null;
    platform_offer_id: string | null;
    platform_listing_id: string | null;
    listing_origin: string | null;
    batch_id: string | null;
    synced_to_ebay_at: string | null;
    listing_price: number | null;
    quantity: number | null;
    ebay_condition: string | null;
    ebay_condition_description: string | null;
    shipping_policy_id: string | null;
    payment_policy_id: string | null;
    return_policy_id: string | null;
    platform_category_id: string | null;
    inventory_item_id: string | null;
  };
  const byId = new Map<string, OwnedListingRow>(
    ((rows ?? []) as unknown as OwnedListingRow[]).map((r) => [r.id, r]),
  );

  const resolve = (id: string): LoadedListing | null => {
    const row = byId.get(id);
    if (!row) return null;
    return {
      id,
      origin: deriveListingOrigin({
        listing_origin: row.listing_origin,
        platform: row.platform,
        platform_listing_id: row.platform_listing_id,
        batch_id: row.batch_id,
        synced_to_ebay_at: row.synced_to_ebay_at,
      }),
    };
  };

  // Persist the writable fields locally, then push the listing to its
  // marketplace through the adapter (an idempotent re-publish for eBay).
  const apply = async (
    listing: LoadedListing,
    applyFields: string[],
  ): Promise<{
    ok: boolean;
    error?: string;
    /**
     * US-2869: the technical string, kept OUT of `error`. `error` is what a
     * seller reads; this is what a support ticket needs. Never merge them --
     * that merge is how a raw PostgREST message reached a toast.
     */
    detail?: string;
    previous?: Record<string, unknown>;
  }> => {
    const row = byId.get(listing.id)!;
    const rowPatch = patchFor(listing.id) as Record<string, unknown>;
    const writePatch: Record<string, unknown> = {};
    // US-2172: captured BEFORE the write, and only for the fields actually
    // applied — a blocked or unwritten field has nothing to undo, and offering
    // to restore one would push a value nobody changed.
    const previous: Record<string, unknown> = {};
    for (const f of applyFields) {
      writePatch[f] = rowPatch[f];
      previous[f] = (row as unknown as Record<string, unknown>)[f] ?? null;
    }
    if (Object.keys(writePatch).length > 0) {
      const { error } = await supabaseAdmin
        .from("listings")
        .update(writePatch as never)
        .eq("id", listing.id);
      if (error) {
        return {
          ok: false,
          error: "Could not save the listing.",
          detail: error.message.slice(0, 200),
        };
      }
    }

    const adapter = resolveAdapter(row.platform);
    if (!adapter) {
      return { ok: false, error: `${row.platform ?? "This marketplace"} isn't a supported marketplace.` };
    }
    if (!row.inventory_item_id) {
      return { ok: false, error: "Listing has no linked inventory item." };
    }
    const price = (rowPatch.listing_price as number | undefined) ?? row.listing_price ?? 0;
    const res = await adapter.updateListing({
      ownerId: userId,
      inventoryItemId: row.inventory_item_id,
      listingRowId: listing.id,
      price,
    });
    return res.ok
      ? { ok: true, previous }
      : { ok: false, error: res.error, detail: res.detail };
  };

  const results = await processBulkEdit(ids, fieldNames, resolve, apply);
  const summary = summarizeBulkEdit(results);

  await writeAuditLog(c, {
    action: "flipdesk.bulk_edit_listings",
    targetType: "listings",
    details: { requested: ids.length, fields: allFields, per_item: !!perItem, ...summary },
  });
  return c.json({ ok: true, results, summary, total: results.length });
};

flipdeskListingsRoutes.post("/bulk-edit", bulkEditListingsHandler);
