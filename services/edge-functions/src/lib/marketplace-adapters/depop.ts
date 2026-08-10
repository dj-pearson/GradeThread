import {
  buildConsentUrl,
  codeChallengeS256,
  generateCodeVerifier,
  getDepopConnection,
  isDepopEnabled,
} from "../depop-client.ts";
import {
  deleteDepopProduct,
  type DepopProductInput,
  listDepopOrders,
  upsertDepopProduct,
} from "../depop-api.ts";
import { handleDepopOrderEvent } from "../depop-orders.ts";
import { supabaseAdmin } from "../supabase.ts";
import {
  filterListablePhotos,
  type ItemPhotoUrlRow,
  publicItemPhotoUrl,
} from "../item-photo-storage.ts";
import { mapSiblingListingFields } from "../cross-listing-fields.ts";
import type { StoredPlatformVariant } from "../cross-listing-fields.ts";
import { buildGtGradeField, embedGtGradeBlock } from "../gt-grade-standard.ts";
import { getMarketplaceSpec, mapCondition } from "../marketplace-specs.ts";
import {
  type AdapterEndInput,
  type AdapterResult,
  type MarketplaceAdapter,
} from "./types.ts";

// Depop adapter (US-714) — now a REAL second API marketplace. The connection
// half (US-713) is OAuth 2.0 + PKCE; this completes the LISTING + ORDER half:
//   • publish / updateListing → upsert via PUT /api/v1/products/{sku} (the same
//     endpoint creates AND updates, keyed by SKU — so an update is a re-publish)
//   • delist                  → DELETE the product by SKU
//   • syncOrders              → pull orders → sale rows + cross-platform auto-end
//   • syncListings            → orders carry the sale signal; a separate listing
//                               pull isn't needed (no-op success)
//
// EVERYTHING stays gated behind isDepopEnabled() (DEPOP_ENABLED + creds): while
// partner access is pending (US-712), every method returns 503 — no fake flow.
//
// SECURITY (US-268): every listing row is re-loaded by id and its ownership
// verified against the ownerId the dispatcher passed (service-role bypasses RLS).

const DISABLED: AdapterResult = {
  ok: false,
  status: 503,
  error: "Depop is not available yet — partner access is pending.",
};

interface DepopListingRow {
  id: string;
  inventory_item_id: string;
  platform: string;
  platform_listing_id: string | null;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  platform_fields: Record<string, StoredPlatformVariant> | null;
  inventory_items: {
    user_id: string;
    title: string | null;
    brand: string | null;
    sku: string | null;
    item_category: string | null;
    grade_value: number | null;
    grade_label: string | null;
    certificate_url: string | null;
  };
}

// Loads the Depop listings row + its parent item and confirms the caller owns it
// (service-role bypasses RLS). Returns null when not found / not owned / not a
// depop row.
async function loadOwnedDepopListing(
  ownerId: string,
  listingRowId: string,
): Promise<DepopListingRow | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform, platform_listing_id, listing_title, " +
        "listing_description, listing_price, platform_fields, " +
        "inventory_items!inner(user_id, title, brand, sku, item_category, " +
        "grade_value, grade_label, certificate_url)",
    )
    .eq("id", listingRowId)
    .maybeSingle();
  const row = data as unknown as DepopListingRow | null;
  if (!row) return null;
  if (row.inventory_items.user_id !== ownerId) return null;
  if (row.platform !== "depop") return null;
  return row;
}

// Resolves the item's photos to PUBLIC urls Depop can ingest. item-photos is the
// public listing-image bucket (CLAUDE.md), so getPublicUrl is correct here (NOT
// the private submission-images bucket). Capped at the platform's maxPhotos.
async function resolveImageUrls(itemId: string, maxPhotos: number): Promise<string[]> {
  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("storage_path, photo_url, sort_order, photo_type, photo_role")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });
  const urls: string[] = [];
  // US-2271: this pushed listing imagery to a public marketplace without the
  // two exclusions every other publish path applies. filterListablePhotos drops
  // 'internal' (price tags, receipts — the seller's cost basis) and the
  // MeasureCard frame; publicItemPhotoUrl refuses a care-label/certificate photo
  // that lives in the private bucket instead of minting a public URL that 404s.
  for (const p of filterListablePhotos((photoRows ?? []) as ItemPhotoUrlRow[])) {
    const url = publicItemPhotoUrl(p);
    if (url) urls.push(url);
    if (urls.length >= maxPhotos) break;
  }
  return urls;
}

// Depop products are keyed by SKU. Reseller items SHOULD carry one; when they
// don't, derive a stable SKU from the item id AND persist it so the order feed's
// echoed SKU round-trips back to this listing (depop-orders matches on
// inventory_items.sku).
async function resolveSku(row: DepopListingRow): Promise<string> {
  const existing = row.inventory_items.sku?.trim();
  if (existing) return existing;
  const derived = `gt-${row.inventory_item_id.slice(0, 12)}`;
  await supabaseAdmin
    .from("inventory_items")
    .update({ sku: derived })
    .eq("id", row.inventory_item_id)
    .is("sku", null);
  return derived;
}

async function publishDepop(
  ownerId: string,
  listingRowId: string,
  price: number,
): Promise<AdapterResult> {
  if (!isDepopEnabled()) return DISABLED;
  const conn = await getDepopConnection(ownerId);
  if (!conn) {
    return { ok: false, status: 400, error: "Connect your Depop shop first." };
  }
  const row = await loadOwnedDepopListing(ownerId, listingRowId);
  if (!row) {
    return { ok: false, status: 404, error: "Depop listing not found." };
  }

  const spec = getMarketplaceSpec("depop")!;
  const variant = row.platform_fields?.depop ?? null;
  const item = row.inventory_items;

  // Depop has no title field — the description is the listing text. Prefer the
  // mapped per-platform description, else fall back to the title as a seed.
  // US-1284: embed the canonical, machine-readable GradeThread Standard field
  // (Depop allows off-site links, so the verify URL is included). The grade
  // block is appended first, then the whole thing is clamped to Depop's cap;
  // reserve room so the marker survives the slice.
  const descCap = spec.descriptionMaxLength ?? 1000;
  let description = row.listing_description ?? row.listing_title ?? item.title ?? "";
  if (item.grade_value != null) {
    const block = embedGtGradeBlock(
      "",
      buildGtGradeField({
        grade: item.grade_value,
        tier: item.grade_label,
        certUrl: item.certificate_url,
      }),
      { includeCertUrl: true },
    );
    const base = description.slice(0, Math.max(0, descCap - block.length - 2)).trim();
    description = base ? `${base}\n\n${block}` : block;
  } else {
    description = description.slice(0, descCap);
  }

  // Condition: prefer the AI variant's chosen value, else derive from the grade.
  const condition = variant?.condition?.value ??
    mapCondition("depop", item.grade_value, item.grade_label)?.value ?? null;

  const sku = await resolveSku(row);
  const pictureUrls = await resolveImageUrls(row.inventory_item_id, spec.maxPhotos);

  const input: DepopProductInput = {
    sku,
    description,
    price: price > 0 ? price : (row.listing_price ?? 0),
    condition,
    categoryId: variant?.category ?? null,
    brand: variant?.brand ?? item.brand ?? null,
    size: variant?.size ?? null,
    colour: variant?.color ?? null,
    tags: variant?.tags ?? [],
    pictureUrls,
    quantity: 1,
  };

  try {
    const result = await upsertDepopProduct(conn.token, input);
    const { error: updErr } = await supabaseAdmin
      .from("listings")
      .update({
        platform_listing_id: result.productId ?? sku,
        listing_url: result.listingUrl,
        listing_status: "active",
        is_active: true,
        listed_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (updErr) {
      console.error("[depop-adapter] listing write-back failed:", updErr.message);
    }
    return {
      ok: true,
      platformListingId: result.productId ?? sku,
      listingUrl: result.listingUrl ?? undefined,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Depop publish failed.",
    };
  }
}

async function endDepop(ownerId: string, input: AdapterEndInput): Promise<AdapterResult> {
  if (!isDepopEnabled()) return DISABLED;
  const conn = await getDepopConnection(ownerId);
  if (!conn) {
    return { ok: false, status: 400, error: "Depop is not connected." };
  }
  const row = await loadOwnedDepopListing(ownerId, input.listingRowId);
  if (!row) {
    return { ok: false, status: 404, error: "Depop listing not found." };
  }
  // Depop is keyed by SKU; platform_listing_id holds the product id/slug, but the
  // delete surface is the SKU we published under (resolveSku is deterministic).
  const sku = await resolveSku(row);
  try {
    await deleteDepopProduct(conn.token, sku);
    await supabaseAdmin
      .from("listings")
      .update({ listing_status: "ended", is_active: false })
      .eq("id", row.id);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Depop delist failed.",
    };
  }
}

export const depopAdapter: MarketplaceAdapter = {
  platform: "depop",

  async connect(input) {
    if (!isDepopEnabled()) {
      return {
        ok: false as const,
        status: 503,
        error: "Depop is not available yet — partner access is pending.",
      };
    }
    try {
      // PKCE: stash the verifier on the single-use state row so the callback can
      // present it at the token exchange (migration 00175).
      const codeVerifier = generateCodeVerifier();
      const { error } = await supabaseAdmin.from("oauth_states").insert({
        state: input.state,
        user_id: input.ownerId,
        marketplace: "depop",
        code_verifier: codeVerifier,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      if (error) {
        return {
          ok: false as const,
          status: 500,
          error: "Could not start Depop connect.",
        };
      }
      const challenge = await codeChallengeS256(codeVerifier);
      return { ok: true as const, consentUrl: buildConsentUrl(input.state, challenge) };
    } catch (err) {
      return {
        ok: false as const,
        status: 500,
        error: err instanceof Error ? err.message : "Could not start Depop connect.",
      };
    }
  },

  // getDepopConnection refreshes the access token inline when it's near expiry,
  // so confirming the connection resolves also proves the token is fresh.
  async refreshToken(input) {
    if (!isDepopEnabled()) {
      return { ok: false, status: 503, error: "Depop is not available yet." };
    }
    const conn = await getDepopConnection(input.ownerId);
    return conn
      ? { ok: true }
      : { ok: false, status: 400, error: "Depop is not connected." };
  },

  // PUT /products/{sku} is an idempotent upsert, so publish and update are the
  // same call (US-714 AC1).
  publish: (input) => publishDepop(input.ownerId, input.listingRowId, input.price),
  updateListing: (input) => publishDepop(input.ownerId, input.listingRowId, input.price),
  delist: (input) => endDepop(input.ownerId, input),

  // Order events carry the sale signal (syncOrders); Depop has no separate
  // listing-state pull we need beyond that, so this is a no-op success.
  syncListings: () => Promise.resolve({ ok: true, detail: "Depop has no separate listing pull." }),

  async syncOrders(input) {
    if (!isDepopEnabled()) {
      return { ok: false, status: 503, error: "Depop is not available yet." };
    }
    const conn = await getDepopConnection(input.ownerId);
    if (!conn) {
      return { ok: false, status: 400, error: "Connect your Depop shop first." };
    }
    try {
      const orders = await listDepopOrders(conn.token);
      let sales = 0;
      for (const order of orders) {
        const res = await handleDepopOrderEvent(input.ownerId, order);
        sales += res.salesNew;
      }
      await supabaseAdmin
        .from("marketplace_connections")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("user_id", input.ownerId)
        .eq("marketplace", "depop");
      return { ok: true, detail: `Synced ${orders.length} order(s), ${sales} new sale(s).` };
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: err instanceof Error ? err.message : "Depop order sync failed.",
      };
    }
  },

  mapDraftToListing: (input) =>
    mapSiblingListingFields("depop", input.source, input.price, input.variant),
};
