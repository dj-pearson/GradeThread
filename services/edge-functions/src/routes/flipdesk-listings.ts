import { Hono } from "hono";
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
import {
  mapSiblingListingFields,
  type StoredPlatformVariant,
  validateSiblingForPublish,
} from "../lib/cross-listing-fields.ts";
import { generatePlatformVariants } from "../lib/ai-listing.ts";
import { withAiAction } from "../lib/ai-metering.ts";
import { checkQuota } from "./flipdesk-ai.ts";
import { recordRelist } from "../lib/passport-relist.ts";
import { loadPendingDelists } from "../lib/pending-delists.ts";
import { ebayOriginWriteLock } from "../lib/sync-precedence.ts";
import {
  isNoEbayConnectionError,
  isOfferAlreadyEndedError,
  updateOfferPrice,
} from "../lib/ebay-client.ts";
import { MAX_BULK_EDIT_ITEMS } from "../lib/bulk-listing-edit.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import {
  markItemListed,
  resyncItemListedStatus,
} from "../lib/active-listings.ts";

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
  badge_enabled: boolean;
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
        "listing_description, primary_photo_id, badge_enabled, " +
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
  const groupId = draft.draft_id ?? draft.id;
  if (!draft.draft_id) {
    const { error: selfErr } = await supabaseAdmin
      .from("listings")
      .update({ draft_id: draft.id })
      .eq("id", draft.id);
    if (selfErr) {
      return c.json({ error: "Could not start the cross-listing group." }, 500);
    }
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
    // US-708: resolve the adapter from the platform via the registry. An
    // unknown platform yields a typed 501 NotImplemented rather than silently
    // falling through to eBay (the US-599 gap).
    const adapter = resolveAdapter(platform);
    if (!adapter) {
      results[platform] = toPushResult(
        {
          ok: false,
          status: 501,
          error: `${platform} cross-listing isn't supported yet.`,
        },
        "",
        price,
      );
      continue;
    }

    if (platform === draft.platform) {
      // The source draft IS this platform's row (eBay today) — publish it
      // directly rather than minting a duplicate.
      const res = await adapter.publish({
        ownerId,
        inventoryItemId: draft.inventory_item_id,
        listingRowId: draft.id,
        price,
      });
      results[platform] = toPushResult(res, draft.id, price);
      continue;
    }

    // US-564: map the shared draft onto this platform's requirements (title /
    // description clamped to its limits, condition/category/tags carried
    // through) instead of copying the eBay draft verbatim.
    const mapped = mapSiblingListingFields(
      platform,
      {
        listing_title: draft.listing_title,
        listing_description: draft.listing_description,
      },
      price,
      variantMap[platform],
    );

    // Reuse the group's existing row for this platform (idempotent re-push)
    // or create the denormalized sibling.
    const { data: existing } = await supabaseAdmin
      .from("listings")
      .select("id")
      .eq("draft_id", groupId)
      .eq("platform", platform)
      // US-1638: defense-in-depth — groupId already derives from the
      // owner-verified draft, but scope the sibling lookup to the tenant too
      // (free + index-backed via listings.user_id, migration 00146).
      .eq("user_id", ownerId)
      .maybeSingle();
    let rowId = (existing as { id: string } | null)?.id ?? null;
    if (rowId) {
      const update: Record<string, unknown> = {
        listing_price: price,
        listing_title: mapped.listing_title,
        listing_description: mapped.listing_description,
      };
      // Only overwrite platform_fields when we actually have a variant — never
      // clobber a previously generated one with null.
      if (mapped.platform_fields) update.platform_fields = mapped.platform_fields;
      await supabaseAdmin
        .from("listings")
        .update(update)
        .eq("id", rowId)
        .eq("user_id", ownerId); // US-1638: tenant-scope the sibling update too
    } else {
      const { data: created, error: insErr } = await supabaseAdmin
        .from("listings")
        .insert({
          inventory_item_id: draft.inventory_item_id,
          platform,
          // US-1077: a FlipDesk cross-listing sibling is GradeThread-originated.
          listing_origin: "gradethread",
          listing_status: "draft",
          is_active: false,
          listing_price: price,
          listing_title: mapped.listing_title,
          listing_description: mapped.listing_description,
          platform_fields: mapped.platform_fields ?? undefined,
          primary_photo_id: draft.primary_photo_id,
          badge_enabled: draft.badge_enabled,
          draft_id: groupId,
        })
        .select("id")
        .single();
      if (insErr || !created) {
        results[platform] = {
          ok: false,
          status: 500,
          error: `Could not create the ${platform} listing row.`,
          listing_row_id: "",
          price,
        };
        continue;
      }
      rowId = (created as { id: string }).id;

      // US-1095: a NEW listing for a passport-linked item CONTINUES the chain —
      // append a 'listed' event to the same garment (no new garment created;
      // tenant-scoped via the item's owner). US-1124: awaited (not fire-and-forget)
      // so the 'listed' event is reliably persisted before the response returns —
      // the next buyer's passport claim then includes this relist. recordRelist is
      // best-effort internally (never throws), so awaiting can't fail the push.
      await recordRelist(draft.inventory_item_id, ownerId, platform);
    }

    // US-725: pre-flight the mapped sibling against the platform's requirements
    // registry before spending an API call on a draft the platform will reject
    // (over-limit title, missing required field, invalid condition, unmapped
    // category). Error-level issues block this platform's publish; the sibling
    // row stays a draft so the seller can fix it in the Listing Kit and re-push.
    const preflight = validateSiblingForPublish(platform, mapped);
    if (!preflight.ok) {
      const blockers = preflight.issues
        .filter((i) => i.level === "error")
        .map((i) => i.message);
      results[platform] = toPushResult(
        {
          ok: false,
          status: 422,
          error: blockers.join(" • "),
          blockers,
        },
        rowId,
        price,
      );
      continue;
    }

    const res = await adapter.publish({
      ownerId,
      inventoryItemId: draft.inventory_item_id,
      listingRowId: rowId,
      price,
    });
    results[platform] = toPushResult(res, rowId, price);
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
const EXTENSION_PLATFORMS = ["poshmark", "mercari", "grailed"] as const;
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
  if (itemErr) return c.json({ error: "Could not load the item." }, 500);
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
  const { data: baseRow } = await supabaseAdmin
    .from("listings")
    .select("id, draft_id, listing_price")
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const base = baseRow as
    | { id: string; draft_id: string | null; listing_price: number | null }
    | null;
  const groupId = base?.draft_id ?? base?.id ?? null;

  const price =
    (base?.listing_price && base.listing_price > 0 ? base.listing_price : null) ??
    (item.target_price && item.target_price > 0 ? item.target_price : 0);

  const now = new Date().toISOString();

  // One row per (item, platform): refresh it if it already exists, else create.
  const { data: existingRow } = await supabaseAdmin
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
      return c.json({ error: "Could not update the cross-listing." }, 500);
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
    return c.json({ error: "Could not record the cross-listing." }, 500);
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
      "listing_status, platform_offer_id, platform_listing_id, synced_to_ebay_at",
    )
    .eq("inventory_item_id", itemId);
  const hasLive = (listings ?? []).some((l) => {
    const row = l as {
      listing_status: string | null;
      platform_offer_id: string | null;
      platform_listing_id: string | null;
      synced_to_ebay_at: string | null;
    };
    const status = row.listing_status ?? "";
    // Terminal states never block.
    if (status === "ended" || status === "sold") return false;
    // An active lifecycle status is live (covers eBay + manually-marked-listed).
    if (status === "active" || status === "relisted") return true;
    // Any other status (e.g. 'draft'): only live if it was actually published to
    // a marketplace — a real offer/listing id or a completed eBay sync.
    return !!row.platform_offer_id || !!row.platform_listing_id ||
      !!row.synced_to_ebay_at;
  });
  if (hasLive) {
    return c.json({
      error:
        "This item has a live listing. End the listing first, then delete it.",
      code: "has_live_listing",
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

interface OwnedListingRow {
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
}

// Owner-verified listing load (US-268 rule 2 — ownership via the parent item).
// Selects the columns the agnostic lifecycle needs, INCLUDING `platform`, whose
// absence from the eBay loader is what let the origin lock be computed against a
// hardcoded "ebay" for every row.
async function loadOwnedListing(
  listingId: string,
  ownerId: string,
): Promise<OwnedListingRow | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform, listing_price, listing_status, listing_url, " +
        "platform_offer_id, platform_listing_id, listing_origin, batch_id, " +
        "synced_to_ebay_at, marketplace_connection_id, inventory_items!inner(user_id)",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as OwnedListingRow & {
    inventory_items: { user_id: string };
  };
  if (row.inventory_items.user_id !== ownerId) return null;
  return row;
}

// Was this row ever actually published to its marketplace? This is orthogonal to
// is_active: a row can sit in 'draft' status (is_active=false since US-2176) yet
// have reached the marketplace, and that published-draft must still count as
// live. So liveness is status + this upstream check, not the is_active mirror.
function wasPublishedUpstream(row: OwnedListingRow): boolean {
  return Boolean(
    row.platform_offer_id || row.platform_listing_id || row.synced_to_ebay_at,
  );
}

// The 409 an eBay-ORIGINATED listing gets for any write to a field eBay owns
// (US-1976). Computed against the row's real platform, so a Shopify row is never
// mislabelled as eBay-owned.
function originLockResponse(
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
function platformName(platform: string | null): string {
  return platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : "This marketplace";
}

// Status codes the lifecycle handlers can return, as a literal union (the
// LoadListingResult convention in flipdesk-ebay.ts) so no handler has to cast a
// bare number into c.json's status parameter.
type LifecycleStatus = 409 | 500 | 501 | 502;
interface LifecycleFailure {
  status: LifecycleStatus;
  error: string;
}

// Collapse an adapter's numeric status into the codes this surface returns.
// Explicit rather than a cast: an adapter is free to hand back anything, and
// asserting `as 502` over a 400 would put a lie in the type system.
function adapterStatus(status: number): 409 | 501 | 502 {
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
async function pushPriceUpstream(
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

// POST /:id/price — reprice ONE listing on its own marketplace.
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

  const row = await loadOwnedListing(listingId, ownerId);
  if (!row) return c.json({ error: "Listing not found." }, 404);

  const lock = originLockResponse(row, ["listing_price"]);
  if (lock.locked) return c.json(lock.body, 409);

  // A draft that was never published has no marketplace to push to — just record
  // the price. This is the ONE legitimate local-only write, and it is local-only
  // because nothing is live, not because a remote call failed.
  if (!wasPublishedUpstream(row)) {
    const { error } = await supabaseAdmin
      .from("listings")
      .update({ listing_price: price })
      .eq("id", listingId);
    if (error) return c.json({ error: "Could not save the price." }, 500);
    return c.json({ ok: true, listing_id: listingId, price, pushed: false });
  }

  // Push FIRST. A failure returns here without ever having touched the local
  // row, so the seller's price keeps matching the live listing — no rollback to
  // get wrong, and no window where the two disagree.
  const failure = await pushPriceUpstream(ownerId, row, price);
  if (failure) return c.json({ error: failure.error }, failure.status);

  const { error: writeErr } = await supabaseAdmin
    .from("listings")
    .update({ listing_price: price })
    .eq("id", listingId);
  if (writeErr) {
    // The marketplace HAS the new price; only our copy is stale. Report it
    // rather than claiming success, but say which way round the mismatch is —
    // "retry" would otherwise re-push a price that is already live.
    console.error("[flipdesk-listings] price pushed but local write failed:", writeErr.message);
    return c.json(
      {
        error:
          "The new price is live on the marketplace, but we couldn't update our copy. " +
          "It'll correct on the next sync.",
      },
      500,
    );
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

  return c.json({ ok: true, listing_id: listingId, price, pushed: true });
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

  const row = await loadOwnedListing(listingId, ownerId);
  if (!row) return c.json({ error: "Listing not found." }, 404);

  if (row.listing_status === "ended" || row.listing_status === "sold") {
    return c.json({ ok: true, listing_id: listingId, already_ended: true });
  }

  // Nothing was ever published — end it locally and move the item back to a
  // draft so it can be relisted.
  if (!wasPublishedUpstream(row)) {
    await endLocally(listingId, row.inventory_item_id, ownerId);
    return c.json({ ok: true, listing_id: listingId, ended_upstream: false });
  }

  const adapter = resolveAdapter(row.platform);
  if (!adapter) {
    return c.json(
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
    });
    if (!res.ok) {
      return c.json(
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
      return c.json({
        ok: true,
        listing_id: listingId,
        ended_upstream: false,
        note: "The listing was already not live on the marketplace.",
      });
    }
    if (isNoEbayConnectionError(err)) {
      return c.json(
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
    return c.json(
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
  return c.json({ ok: true, listing_id: listingId, ended_upstream: true });
});

// Reconcile the local rows after a confirmed end: the listing stops being live
// and the item returns to 'drafted' so it can be relisted. Tenant-scoped on the
// item write; the listing id is already owner-verified by the caller.
//
// US-2179: the item only goes back to 'drafted' once NOTHING is live anywhere.
// The old unconditional revert meant ending the Depop listing of an item still
// live on eBay marked the whole item a draft — freeing an activeListings cap
// slot the seller was still using, and showing a selling item in the Drafts tab.
async function endLocally(
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

    const adapter = resolveAdapter(row.platform);
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
