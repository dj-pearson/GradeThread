import {
  buildConsentUrl,
  codeChallengeS256,
  generateCodeVerifier,
  getEtsyConnection,
  isEtsyEnabled,
} from "../etsy-client.ts";
import {
  createEtsyListing,
  defaultEtsyTaxonomyId,
  type EtsyListingInput,
  getEtsyShippingProfiles,
  listEtsyReceipts,
  setEtsyListingState,
  updateEtsyListing,
  uploadEtsyListingImage,
} from "../etsy-api.ts";
import { handleEtsyReceiptEvent } from "../etsy-orders.ts";
import { supabaseAdmin } from "../supabase.ts";
import {
  filterListablePhotos,
  type ItemPhotoUrlRow,
  publicItemPhotoUrl,
} from "../item-photo-storage.ts";
import { mapSiblingListingFields } from "../cross-listing-fields.ts";
import type { StoredPlatformVariant } from "../cross-listing-fields.ts";
import { buildGtGradeField, embedGtGradeBlock } from "../gt-grade-standard.ts";
import { getMarketplaceSpec } from "../marketplace-specs.ts";
import {
  type AdapterEndInput,
  type AdapterResult,
  type MarketplaceAdapter,
} from "./types.ts";

// Etsy adapter (US-1659 connection + US-1660 listing/receipt path). A real API
// marketplace: connect is OAuth2 + PKCE (etsy-client); this completes the LISTING
// + RECEIPT half:
//   • publish / updateListing → create-or-update a listing, upload each image as
//     BINARY (Etsy rejects image URLs), then activate. Keyed by the Etsy
//     listing id we persist as platform_listing_id, so an update is idempotent.
//   • delist                  → PATCH the listing state to 'inactive' (404 = gone)
//   • syncOrders              → pull receipts → sale rows + cross-platform auto-end
//   • syncListings            → receipts carry the sale signal; no separate pull
//                               needed (no-op success)
//
// EVERYTHING stays gated behind isEtsyEnabled() (ETSY_ENABLED + keystring): while
// app approval is pending, every method returns 503 — no fake flow.
//
// SECURITY (US-268): every listing row is re-loaded by id and its ownership
// verified against the ownerId the dispatcher passed (service-role bypasses RLS).

const DISABLED: AdapterResult = {
  ok: false,
  status: 503,
  error: "Etsy is not available yet — app approval is pending.",
};

interface EtsyListingRow {
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
    item_category: string | null;
    grade_value: number | null;
    grade_label: string | null;
    certificate_url: string | null;
  };
}

// Loads the Etsy listings row + its parent item and confirms the caller owns it
// (service-role bypasses RLS). Returns null when not found / not owned / not an
// etsy row.
async function loadOwnedEtsyListing(
  ownerId: string,
  listingRowId: string,
): Promise<EtsyListingRow | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform, platform_listing_id, listing_title, " +
        "listing_description, listing_price, platform_fields, " +
        "inventory_items!inner(user_id, title, brand, item_category, " +
        "grade_value, grade_label, certificate_url)",
    )
    .eq("id", listingRowId)
    .maybeSingle();
  const row = data as unknown as EtsyListingRow | null;
  if (!row) return null;
  if (row.inventory_items.user_id !== ownerId) return null;
  if (row.platform !== "etsy") return null;
  return row;
}

// Resolves the item's photos to PUBLIC urls (item-photos is the public listing
// bucket, CLAUDE.md). Etsy fetches these bytes at upload time. Capped at the
// platform's maxPhotos.
async function resolveImageUrls(itemId: string, maxPhotos: number): Promise<string[]> {
  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("storage_path, photo_url, sort_order, photo_type")
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

// Resolve the Etsy taxonomy leaf: the per-platform variant's category when it's a
// numeric leaf id, else the operator default (ETSY_DEFAULT_TAXONOMY_ID). Etsy
// REQUIRES a valid leaf, so a null here is a hard blocker.
function resolveTaxonomyId(variant: StoredPlatformVariant | null): number | null {
  const cat = variant?.category?.trim();
  const n = cat ? Number(cat) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return defaultEtsyTaxonomyId();
}

async function publishEtsy(
  ownerId: string,
  listingRowId: string,
  price: number,
): Promise<AdapterResult> {
  if (!isEtsyEnabled()) return DISABLED;
  const conn = await getEtsyConnection(ownerId);
  if (!conn) {
    return { ok: false, status: 400, error: "Connect your Etsy shop first." };
  }
  if (!conn.shopId) {
    return {
      ok: false,
      status: 409,
      error: "Your Etsy account has no shop yet — open a shop on Etsy, then reconnect.",
    };
  }
  const row = await loadOwnedEtsyListing(ownerId, listingRowId);
  if (!row) {
    return { ok: false, status: 404, error: "Etsy listing not found." };
  }

  const spec = getMarketplaceSpec("etsy")!;
  const variant = row.platform_fields?.etsy ?? null;
  const item = row.inventory_items;

  // Resolve the required physical-listing fields up front so we fail with clear
  // blockers instead of a raw Etsy 400.
  const taxonomyId = resolveTaxonomyId(variant);
  if (taxonomyId == null) {
    return {
      ok: false,
      status: 422,
      error: "No Etsy category resolved for this item.",
      blockers: ["Pick an Etsy category, or set ETSY_DEFAULT_TAXONOMY_ID."],
    };
  }
  const profiles = await getEtsyShippingProfiles(conn.token, conn.shopId).catch(() => []);
  const shippingProfileId = profiles[0]?.shippingProfileId;
  if (!shippingProfileId) {
    return {
      ok: false,
      status: 422,
      error: "No Etsy shipping profile found.",
      blockers: ["Create a shipping profile in your Etsy shop settings first."],
    };
  }

  const title = (variant?.title ?? row.listing_title ?? item.title ?? "Item").slice(0, 140);

  // US-1284: embed the canonical, machine-readable GradeThread Standard field.
  // Etsy allows off-site links, so the verify URL is included.
  let description = variant?.description ?? row.listing_description ?? item.title ?? "";
  if (item.grade_value != null) {
    description = embedGtGradeBlock(
      description,
      buildGtGradeField({
        grade: item.grade_value,
        tier: item.grade_label,
        certUrl: item.certificate_url,
      }),
      { includeCertUrl: true },
    );
  }

  const input: EtsyListingInput = {
    title,
    description,
    price: price > 0 ? price : (row.listing_price ?? 0),
    quantity: 1,
    taxonomyId,
    shippingProfileId: Number(shippingProfileId),
    whoMade: "someone_else",
    whenMade: "before_2005",
    isSupply: false,
    tags: variant?.tags ?? [],
  };

  try {
    // Create-or-update, keyed by the persisted Etsy listing id.
    const result = row.platform_listing_id
      ? await updateEtsyListing(conn.token, conn.shopId, row.platform_listing_id, input)
      : await createEtsyListing(conn.token, conn.shopId, input);
    const listingId = result.listingId ?? row.platform_listing_id;
    if (!listingId) {
      return { ok: false, status: 502, error: "Etsy did not return a listing id." };
    }

    // Upload images (best-effort per image), then activate. Etsy needs at least
    // one image before a listing can go active.
    const urls = await resolveImageUrls(row.inventory_item_id, spec.maxPhotos);
    let uploaded = 0;
    for (let i = 0; i < urls.length; i++) {
      const ok = await uploadEtsyListingImage(conn.token, conn.shopId, listingId, urls[i]!, i + 1)
        .catch(() => false);
      if (ok) uploaded += 1;
    }
    // Only activate when the listing has imagery; otherwise leave it as a draft
    // the seller can finish (Etsy rejects activation of an imageless listing).
    if (uploaded > 0) {
      await setEtsyListingState(conn.token, conn.shopId, listingId, "active");
    }

    const { error: updErr } = await supabaseAdmin
      .from("listings")
      .update({
        platform_listing_id: listingId,
        listing_url: result.listingUrl,
        listing_status: uploaded > 0 ? "active" : "draft",
        is_active: uploaded > 0,
        listed_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (updErr) {
      console.error("[etsy-adapter] listing write-back failed:", updErr.message);
    }
    return {
      ok: true,
      platformListingId: listingId,
      listingUrl: result.listingUrl ?? undefined,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Etsy publish failed.",
    };
  }
}

async function endEtsy(ownerId: string, input: AdapterEndInput): Promise<AdapterResult> {
  if (!isEtsyEnabled()) return DISABLED;
  const conn = await getEtsyConnection(ownerId);
  if (!conn || !conn.shopId) {
    return { ok: false, status: 400, error: "Etsy is not connected." };
  }
  const row = await loadOwnedEtsyListing(ownerId, input.listingRowId);
  if (!row) {
    return { ok: false, status: 404, error: "Etsy listing not found." };
  }
  const listingId = row.platform_listing_id ?? input.platformListingId;
  if (!listingId) {
    // Nothing live on Etsy — treat as already ended locally.
    await supabaseAdmin
      .from("listings")
      .update({ listing_status: "ended", is_active: false })
      .eq("id", row.id);
    return { ok: true };
  }
  try {
    await setEtsyListingState(conn.token, conn.shopId, listingId, "inactive");
    await supabaseAdmin
      .from("listings")
      .update({ listing_status: "ended", is_active: false })
      .eq("id", row.id);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Etsy delist failed.",
    };
  }
}

export const etsyAdapter: MarketplaceAdapter = {
  platform: "etsy",

  async connect(input) {
    if (!isEtsyEnabled()) {
      return {
        ok: false as const,
        status: 503,
        error: "Etsy is not available yet — app approval is pending.",
      };
    }
    try {
      // PKCE: stash the verifier on the single-use state row so the callback can
      // present it at the token exchange (migration 00175).
      const codeVerifier = generateCodeVerifier();
      const { error } = await supabaseAdmin.from("oauth_states").insert({
        state: input.state,
        user_id: input.ownerId,
        marketplace: "etsy",
        code_verifier: codeVerifier,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      if (error) {
        return { ok: false as const, status: 500, error: "Could not start Etsy connect." };
      }
      const challenge = await codeChallengeS256(codeVerifier);
      return { ok: true as const, consentUrl: buildConsentUrl(input.state, challenge) };
    } catch (err) {
      return {
        ok: false as const,
        status: 500,
        error: err instanceof Error ? err.message : "Could not start Etsy connect.",
      };
    }
  },

  // getEtsyConnection refreshes the access token inline when it's near expiry,
  // so confirming the connection resolves also proves the token is fresh.
  async refreshToken(input) {
    if (!isEtsyEnabled()) {
      return { ok: false, status: 503, error: "Etsy is not available yet." };
    }
    const conn = await getEtsyConnection(input.ownerId);
    return conn
      ? { ok: true }
      : { ok: false, status: 400, error: "Etsy is not connected." };
  },

  // create → upload images → activate is idempotent by the persisted listing id,
  // so publish and update share one path.
  publish: (input) => publishEtsy(input.ownerId, input.listingRowId, input.price),
  updateListing: (input) => publishEtsy(input.ownerId, input.listingRowId, input.price),
  delist: (input) => endEtsy(input.ownerId, input),

  // Receipts carry the sale signal (syncOrders); Etsy has no separate listing
  // pull we need beyond that, so this is a no-op success.
  syncListings: () =>
    Promise.resolve({ ok: true, detail: "Etsy has no separate listing pull." }),

  async syncOrders(input) {
    if (!isEtsyEnabled()) {
      return { ok: false, status: 503, error: "Etsy is not available yet." };
    }
    const conn = await getEtsyConnection(input.ownerId);
    if (!conn) {
      return { ok: false, status: 400, error: "Connect your Etsy shop first." };
    }
    if (!conn.shopId) {
      return { ok: false, status: 409, error: "Your Etsy account has no shop." };
    }
    try {
      const receipts = await listEtsyReceipts(conn.token, conn.shopId);
      let sales = 0;
      for (const receipt of receipts) {
        const res = await handleEtsyReceiptEvent(input.ownerId, receipt);
        sales += res.salesNew;
      }
      await supabaseAdmin
        .from("marketplace_connections")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("user_id", input.ownerId)
        .eq("marketplace", "etsy");
      return { ok: true, detail: `Synced ${receipts.length} receipt(s), ${sales} new sale(s).` };
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: err instanceof Error ? err.message : "Etsy receipt sync failed.",
      };
    }
  },

  mapDraftToListing: (input) =>
    mapSiblingListingFields("etsy", input.source, input.price, input.variant),
};
