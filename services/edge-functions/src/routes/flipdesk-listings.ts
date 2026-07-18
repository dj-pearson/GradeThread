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
  inventory_items: { user_id: string; target_price: number | null };
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
        "inventory_items!inner(user_id, target_price)",
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
    .select("id, user_id, target_price")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr) return c.json({ error: "Could not load the item." }, 500);
  const item = itemRow as
    | { id: string; user_id: string; target_price: number | null }
    | null;
  if (!item || item.user_id !== ownerId) {
    return c.json({ error: "Item not found." }, 404);
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
    .select("id, inventory_items!inner(user_id)")
    .eq("id", listingId)
    .maybeSingle();
  if (error) return c.json({ error: "Could not load the listing." }, 500);
  const row = data as { id: string; inventory_items: { user_id: string } } | null;
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
  // actually published — NOT the denormalized `is_active` flag, which the
  // listings table defaults to TRUE on every row (so an ordinary, never-published
  // DRAFT is born is_active=true). Trusting is_active blocked deleting normal
  // draft duplicates.
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
