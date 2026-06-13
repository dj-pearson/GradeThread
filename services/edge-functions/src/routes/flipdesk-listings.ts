import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
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
} from "../lib/cross-listing-fields.ts";
import { generatePlatformVariants } from "../lib/ai-listing.ts";

// Multi-marketplace cross-listing dispatch (US-149 + US-564).
//
// POST /cross-push fans a single source draft out into one listings row per
// selected platform (denormalized; siblings share listings.draft_id), then
// asks each platform's adapter to publish. eBay publishes for real via the
// US-121 pipeline; the other adapters return 501 until they're wired up, so
// their rows stay local drafts.
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
      await generatePlatformVariants(itemId, ownerId, missing);
      await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: ownerId });
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
        .eq("id", rowId);
    } else {
      const { data: created, error: insErr } = await supabaseAdmin
        .from("listings")
        .insert({
          inventory_item_id: draft.inventory_item_id,
          platform,
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
