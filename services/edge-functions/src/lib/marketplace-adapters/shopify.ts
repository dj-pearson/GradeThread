import { supabaseAdmin } from "../supabase.ts";
import {
  createProduct,
  deleteProduct,
  getShopifyConnection,
  type ShopifyProductInput,
  updateProduct,
} from "../shopify-client.ts";
import { getMarketplaceSpec } from "../marketplace-specs.ts";
import type { AdapterResult, MarketplaceAdapter } from "./types.ts";

// Shopify adapter (US-599) — the first REAL non-eBay publish path. cross-push
// (flipdesk-listings.ts) creates/maps the Shopify `listings` row, then calls
// publish() here to push it live via the Admin API. end() delists. Both are
// tenant-scoped (US-268): every row is re-loaded by id and its ownership
// verified against the ownerId the dispatcher passed.

interface ShopifyListingRow {
  id: string;
  inventory_item_id: string;
  platform: string;
  platform_listing_id: string | null;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  primary_photo_id: string | null;
  inventory_items: {
    user_id: string;
    title: string | null;
    brand: string | null;
    sku: string | null;
    item_category: string | null;
  };
}

// Loads the Shopify listings row + its parent item and confirms the caller owns
// it (the service-role client bypasses RLS). Returns null when not found / not
// owned / not a shopify row.
async function loadOwnedShopifyListing(
  ownerId: string,
  listingRowId: string,
): Promise<ShopifyListingRow | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform, platform_listing_id, listing_title, " +
        "listing_description, listing_price, primary_photo_id, " +
        "inventory_items!inner(user_id, title, brand, sku, item_category)",
    )
    .eq("id", listingRowId)
    .maybeSingle();
  const row = data as unknown as ShopifyListingRow | null;
  if (!row) return null;
  if (row.inventory_items.user_id !== ownerId) return null;
  if (row.platform !== "shopify") return null;
  return row;
}

// Resolves the item's photos to PUBLIC image URLs Shopify can ingest by `src`.
// item-photos is the public listing-image bucket (CLAUDE.md), so getPublicUrl
// is the correct accessor here (NOT the private submission-images bucket).
async function resolveImageUrls(
  itemId: string,
  spec: { maxPhotos: number },
): Promise<string[]> {
  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("storage_path, photo_url, sort_order")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });
  const urls: string[] = [];
  for (
    const p of (photoRows ?? []) as Array<{
      storage_path: string | null;
      photo_url: string | null;
    }>
  ) {
    let url = p.photo_url ?? null;
    if (!url && p.storage_path) {
      url = supabaseAdmin.storage.from("item-photos").getPublicUrl(p.storage_path)
        .data.publicUrl;
    }
    if (url) urls.push(url);
    if (urls.length >= spec.maxPhotos) break;
  }
  return urls;
}

async function publishShopify(
  ownerId: string,
  listingRowId: string,
  price: number,
): Promise<AdapterResult> {
  const conn = await getShopifyConnection(ownerId);
  if (!conn) {
    return {
      ok: false,
      status: 400,
      error: "Connect your Shopify store first.",
    };
  }
  const row = await loadOwnedShopifyListing(ownerId, listingRowId);
  if (!row) {
    return { ok: false, status: 404, error: "Shopify listing not found." };
  }

  const spec = getMarketplaceSpec("shopify")!;
  const title = (row.listing_title ?? row.inventory_items.title ?? "Listing")
    .slice(0, spec.titleMaxLength ?? 255);
  const bodyHtml = row.listing_description ?? "";
  const imageUrls = await resolveImageUrls(row.inventory_item_id, spec);

  const input: ShopifyProductInput = {
    title,
    bodyHtml,
    vendor: row.inventory_items.brand,
    productType: row.inventory_items.item_category,
    price: price > 0 ? price : (row.listing_price ?? 0),
    sku: row.inventory_items.sku,
    quantity: 1,
    imageUrls,
    status: "active",
  };

  try {
    const result = row.platform_listing_id
      ? await updateProduct(conn.shop, conn.token, row.platform_listing_id, input)
      : await createProduct(conn.shop, conn.token, input);

    const { error: updErr } = await supabaseAdmin
      .from("listings")
      .update({
        platform_listing_id: result.productId,
        listing_url: result.listingUrl,
        listing_status: "active",
        is_active: true,
        listed_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (updErr) {
      console.error("[shopify-adapter] listing write-back failed:", updErr.message);
    }
    return { ok: true, platformListingId: result.productId, listingUrl: result.listingUrl ?? undefined };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Shopify publish failed.",
    };
  }
}

async function endShopify(
  ownerId: string,
  listingRowId: string,
  platformListingId: string | null,
): Promise<AdapterResult> {
  const conn = await getShopifyConnection(ownerId);
  if (!conn) {
    return { ok: false, status: 400, error: "Shopify is not connected." };
  }
  const row = await loadOwnedShopifyListing(ownerId, listingRowId);
  if (!row) {
    return { ok: false, status: 404, error: "Shopify listing not found." };
  }
  const productId = platformListingId ?? row.platform_listing_id;
  if (!productId) {
    return {
      ok: false,
      status: 409,
      error: "This listing has no Shopify product id to delist.",
    };
  }
  try {
    await deleteProduct(conn.shop, conn.token, productId);
    await supabaseAdmin
      .from("listings")
      .update({ listing_status: "ended", is_active: false })
      .eq("id", row.id);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Shopify delist failed.",
    };
  }
}

export const shopifyAdapter: MarketplaceAdapter = {
  platform: "shopify",
  publish: (input) => publishShopify(input.ownerId, input.listingRowId, input.price),
  end: (input) => endShopify(input.ownerId, input.listingRowId, input.platformListingId),
};
