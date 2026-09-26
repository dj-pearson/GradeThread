// US-3541: Reseller Swap routes, mounted at /api/flipdesk/swap.
//
//   GET  /settings                  the caller's two opt-ins and stale line
//   PUT  /settings                  change them (owner/admin only, main.ts)
//   GET  /tips                      stale eBay listings from sharing sellers,
//                                   filtered to brands the caller sells fast
//   POST /tips/:itemId/dismiss      hide one tip for good
//
// GradeThread is NOT a party to any sale. A tip is a link to the other seller's
// existing eBay listing (with eBay Partner Network tracking when configured,
// see lib/ebay-affiliate.ts). eBay handles payment, shipping, tax and disputes.
// Contract and privacy rules: vault/20-domain/reseller-swap.md.
//
// Tenancy (US-268). This route crosses tenants ON PURPOSE, and only here:
//   * Every read of the CALLER's data (settings, sales, dismissals) is scoped
//     with `.eq("user_id", ownerId)` where ownerId = workspaceOwnerId ?? userId.
//   * The cross-tenant read is limited to sellers whose reseller_swap_settings
//     row says share_stale = true, and to ACTIVE eBay listings only, which the
//     world can already see on ebay.com. The tip DTO (lib/reseller-swap.ts) has
//     no owner id, cost, profit or sales field; the owner id never leaves.
//   * The dismiss write takes an item id from the URL. It is accepted only when
//     that item is a live shared tip right now (a sharing seller's active eBay
//     listing, not the caller's own); anything else is 404, the same body an
//     unknown id gets. Case in tenant-isolation_test.ts.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  brandKey,
  buildFitProfile,
  clampStaleDays,
  FIT_WINDOW_DAYS,
  MIN_STALE_DAYS,
  rankTips,
  type SaleSignal,
  type SwapCandidate,
} from "../lib/reseller-swap.ts";
import {
  ebayListingUrl,
  epnCampaignId,
  withEpnTracking,
} from "../lib/ebay-affiliate.ts";

export const flipdeskSwapRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const IN_CHUNK = 200;
const MAX_SALES = 2000;
const MAX_SHARERS = 5000;
const MAX_CANDIDATE_LISTINGS = 1500;
/** Item states that mean the piece is no longer for sale, whatever eBay says. */
const GONE_STATUSES = new Set([
  "sold",
  "shipped",
  "completed",
  "returned",
  "archived",
]);
/** Photo roles that are listing imagery a buyer sees on eBay anyway. */
const PUBLIC_PHOTO_TYPES = ["front", "flatlay", "on_model", "on_hanger"];

interface SettingsRow {
  share_stale: boolean;
  receive_tips: boolean;
  stale_after_days: number;
}

const DEFAULT_SETTINGS: SettingsRow = {
  share_stale: false,
  receive_tips: false,
  stale_after_days: 60,
};

function chunks<T>(xs: T[], n = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function loadSettings(ownerId: string): Promise<SettingsRow> {
  const { data, error } = await supabaseAdmin
    .from("reseller_swap_settings")
    .select("share_stale, receive_tips, stale_after_days")
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) throw new Error(`settings read: ${error.message}`);
  return (data as SettingsRow | null) ?? DEFAULT_SETTINGS;
}

/** Every OTHER seller who shares, with their own stale line. */
async function loadSharers(
  excludeIds: Set<string>,
): Promise<Map<string, number>> {
  const { data, error } = await supabaseAdmin
    .from("reseller_swap_settings")
    .select("user_id, stale_after_days")
    .eq("share_stale", true)
    .limit(MAX_SHARERS);
  if (error) throw new Error(`sharers read: ${error.message}`);
  const out = new Map<string, number>();
  for (
    const r of (data ?? []) as Array<
      { user_id: string; stale_after_days: number }
    >
  ) {
    if (!excludeIds.has(r.user_id)) out.set(r.user_id, r.stale_after_days);
  }
  return out;
}

/** The caller's recent sales, reduced to brand + days-to-sell. */
async function loadSaleSignals(
  ownerId: string,
  now: number,
): Promise<SaleSignal[]> {
  const since = new Date(now - FIT_WINDOW_DAYS * DAY_MS).toISOString();
  const { data: sales, error } = await supabaseAdmin
    .from("sales")
    .select("inventory_item_id, listing_id, sale_date, sold_at")
    .eq("user_id", ownerId)
    .gte("sale_date", since)
    .order("sale_date", { ascending: false })
    .limit(MAX_SALES);
  if (error) throw new Error(`sales read: ${error.message}`);
  // Read-only row shape. Spelled as a Record so the US-3315 census of sold_at
  // WRITERS (sold-at-provenance_test.ts) does not mistake it for one.
  const rows = (sales ?? []) as Array<
    & {
      inventory_item_id: string;
      listing_id: string | null;
      sale_date: string;
    }
    & Record<"sold_at", string | null>
  >;
  if (rows.length === 0) return [];

  const brands = new Map<string, string | null>();
  for (
    const ids of chunks([...new Set(rows.map((r) => r.inventory_item_id))])
  ) {
    const { data, error: e } = await supabaseAdmin
      .from("inventory_items")
      .select("id, brand")
      .eq("user_id", ownerId)
      .in("id", ids);
    if (e) throw new Error(`items read: ${e.message}`);
    for (
      const i of (data ?? []) as Array<{ id: string; brand: string | null }>
    ) {
      brands.set(i.id, i.brand);
    }
  }

  const listedAt = new Map<string, string>();
  const listingIds = [
    ...new Set(rows.map((r) => r.listing_id).filter((x): x is string => !!x)),
  ];
  for (const ids of chunks(listingIds)) {
    const { data, error: e } = await supabaseAdmin
      .from("listings")
      .select("id, listed_at")
      .eq("user_id", ownerId)
      .in("id", ids);
    if (e) throw new Error(`listings read: ${e.message}`);
    for (const l of (data ?? []) as Array<{ id: string; listed_at: string }>) {
      listedAt.set(l.id, l.listed_at);
    }
  }

  return rows.map((r) => ({
    brand: brands.get(r.inventory_item_id) ?? null,
    listedAt: r.listing_id ? listedAt.get(r.listing_id) ?? null : null,
    soldAt: r.sold_at ?? r.sale_date,
  }));
}

interface ListingRow {
  id: string;
  inventory_item_id: string;
  user_id: string;
  listing_url: string | null;
  platform_listing_id: string | null;
  listing_price: number | string | null;
  listed_at: string;
}

/** Active eBay listings of sharing sellers that are past the global floor. */
async function loadSharedListings(
  sharers: Map<string, number>,
  now: number,
  itemId?: string,
): Promise<ListingRow[]> {
  const cutoff = new Date(now - MIN_STALE_DAYS * DAY_MS).toISOString();
  const out: ListingRow[] = [];
  for (const ids of chunks([...sharers.keys()])) {
    let q = supabaseAdmin
      .from("listings")
      .select(
        "id, inventory_item_id, user_id, listing_url, platform_listing_id, listing_price, listed_at",
      )
      .in("user_id", ids)
      .eq("platform", "ebay")
      .eq("listing_status", "active")
      .eq("is_active", true)
      .lte("listed_at", cutoff);
    if (itemId) q = q.eq("inventory_item_id", itemId);
    const { data, error } = await q
      .order("listed_at", { ascending: true })
      .limit(MAX_CANDIDATE_LISTINGS - out.length);
    if (error) throw new Error(`shared listings read: ${error.message}`);
    out.push(...((data ?? []) as ListingRow[]));
    if (out.length >= MAX_CANDIDATE_LISTINGS) break;
  }
  return out;
}

interface ItemRow {
  id: string;
  user_id: string;
  title: string;
  brand: string | null;
  size: string | null;
  grade_value: number | string | null;
  grade_label: string | null;
  status: string;
}

async function buildCandidates(
  listings: ListingRow[],
  sharers: Map<string, number>,
  wantedBrandKeys: Set<string> | null,
): Promise<SwapCandidate[]> {
  if (listings.length === 0) return [];
  const items = new Map<string, ItemRow>();
  for (
    const ids of chunks([...new Set(listings.map((l) => l.inventory_item_id))])
  ) {
    const { data, error } = await supabaseAdmin
      .from("inventory_items")
      .select(
        "id, user_id, title, brand, size, grade_value, grade_label, status",
      )
      .in("id", ids);
    if (error) throw new Error(`shared items read: ${error.message}`);
    for (const i of (data ?? []) as ItemRow[]) {
      items.set(i.id, i);
    }
  }

  // Keep only listings whose item belongs to the same (sharing) owner and is
  // still for sale, and, when filtering, whose brand the caller can use.
  const kept = listings.filter((l) => {
    const item = items.get(l.inventory_item_id);
    if (!item || item.user_id !== l.user_id || GONE_STATUSES.has(item.status)) {
      return false;
    }
    if (!wantedBrandKeys) return true;
    const k = brandKey(item.brand);
    return !!k && wantedBrandKeys.has(k);
  });
  if (kept.length === 0) return [];

  const photos = new Map<string, string>();
  for (
    const ids of chunks([...new Set(kept.map((l) => l.inventory_item_id))])
  ) {
    const { data, error } = await supabaseAdmin
      .from("item_photos")
      .select("inventory_item_id, photo_url, photo_type, sort_order")
      .in("inventory_item_id", ids)
      .in("photo_type", PUBLIC_PHOTO_TYPES)
      .order("sort_order", { ascending: true });
    if (error) throw new Error(`photos read: ${error.message}`);
    const rows = (data ?? []) as Array<{
      inventory_item_id: string;
      photo_url: string;
      photo_type: string;
    }>;
    // Front first, then whatever sorts first.
    rows.sort((a, b) =>
      Number(b.photo_type === "front") - Number(a.photo_type === "front")
    );
    for (const p of rows) {
      if (
        !photos.has(p.inventory_item_id) && p.photo_url?.startsWith("https://")
      ) {
        photos.set(p.inventory_item_id, p.photo_url);
      }
    }
  }

  const campaign = epnCampaignId();
  const out: SwapCandidate[] = [];
  for (const l of kept) {
    const url = ebayListingUrl(l.listing_url, l.platform_listing_id);
    if (!url) continue;
    const item = items.get(l.inventory_item_id)!;
    const price = l.listing_price == null ? null : Number(l.listing_price);
    const grade = item.grade_value == null ? null : Number(item.grade_value);
    out.push({
      itemId: l.inventory_item_id,
      ownerId: l.user_id,
      ownerStaleDays: sharers.get(l.user_id) ?? MIN_STALE_DAYS,
      title: item.title,
      brand: item.brand,
      size: item.size,
      priceCents: price != null && Number.isFinite(price)
        ? Math.round(price * 100)
        : null,
      listedAt: l.listed_at,
      gradeValue: grade != null && Number.isFinite(grade) ? grade : null,
      gradeLabel: item.grade_label,
      photoUrl: photos.get(l.inventory_item_id) ?? null,
      url: withEpnTracking(url, campaign),
    });
  }
  return out;
}

flipdeskSwapRoutes.get("/settings", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json({ settings: await loadSettings(ownerId) });
  } catch (e) {
    console.error("[flipdesk-swap]", (e as Error).message);
    return c.json({ error: "Could not load swap settings" }, 500);
  }
});

flipdeskSwapRoutes.put("/settings", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const body = await c.req.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected a JSON body" }, 400);
  }
  for (const k of ["share_stale", "receive_tips"] as const) {
    if (k in body && typeof body[k] !== "boolean") {
      return c.json({ error: `${k} must be true or false` }, 400);
    }
  }
  if ("stale_after_days" in body && typeof body.stale_after_days !== "number") {
    return c.json({ error: "stale_after_days must be a number" }, 400);
  }

  let current: SettingsRow;
  try {
    current = await loadSettings(ownerId);
  } catch (e) {
    console.error("[flipdesk-swap]", (e as Error).message);
    return c.json({ error: "Could not load swap settings" }, 500);
  }
  const next: SettingsRow = {
    share_stale: typeof body.share_stale === "boolean"
      ? body.share_stale
      : current.share_stale,
    receive_tips: typeof body.receive_tips === "boolean"
      ? body.receive_tips
      : current.receive_tips,
    stale_after_days: "stale_after_days" in body
      ? clampStaleDays(body.stale_after_days)
      : current.stale_after_days,
  };
  const { error } = await supabaseAdmin
    .from("reseller_swap_settings")
    .upsert({ user_id: ownerId, ...next }, { onConflict: "user_id" });
  if (error) {
    console.error("[flipdesk-swap] settings write:", error.message);
    return c.json({ error: "Could not save swap settings" }, 500);
  }
  return c.json({ settings: next });
});

flipdeskSwapRoutes.get("/tips", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const now = Date.now();
  try {
    const settings = await loadSettings(ownerId);
    if (!settings.receive_tips) {
      return c.json({ enabled: false, tips: [], fit_brands: [] });
    }

    const profile = buildFitProfile(await loadSaleSignals(ownerId, now));
    const fitBrands = [...profile.values()]
      .sort((a, b) => b.sold - a.sold)
      .map((f) => ({
        brand: f.brand,
        sold: f.sold,
        median_days: f.medianDays,
      }));
    if (profile.size === 0) {
      return c.json({ enabled: true, tips: [], fit_brands: [] });
    }

    const exclude = new Set([ownerId, c.get("userId")]);
    const sharers = await loadSharers(exclude);
    if (sharers.size === 0) {
      return c.json({ enabled: true, tips: [], fit_brands: fitBrands });
    }

    const listings = await loadSharedListings(sharers, now);
    const candidates = await buildCandidates(
      listings,
      sharers,
      new Set(profile.keys()),
    );

    const { data: dismissedRows, error: dErr } = await supabaseAdmin
      .from("reseller_swap_dismissals")
      .select("inventory_item_id")
      .eq("user_id", ownerId);
    if (dErr) throw new Error(`dismissals read: ${dErr.message}`);
    const dismissed = new Set(
      ((dismissedRows ?? []) as Array<{ inventory_item_id: string }>).map((r) =>
        r.inventory_item_id
      ),
    );

    const tips = rankTips(candidates, profile, {
      excludeOwnerIds: exclude,
      dismissed,
      now,
    });
    return c.json({ enabled: true, tips, fit_brands: fitBrands });
  } catch (e) {
    console.error("[flipdesk-swap]", (e as Error).message);
    return c.json({ error: "Could not load swap tips" }, 500);
  }
});

flipdeskSwapRoutes.post("/tips/:itemId/dismiss", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const itemId = c.req.param("itemId");
  if (!UUID_RE.test(itemId)) return c.json({ error: "Not found" }, 404);
  const now = Date.now();
  try {
    // Only a LIVE shared tip can be dismissed: a sharing seller's active eBay
    // listing that is not the caller's own. Anything else answers exactly like
    // an unknown id, so this cannot be used to probe other sellers' items.
    const exclude = new Set([ownerId, c.get("userId")]);
    const sharers = await loadSharers(exclude);
    const listings = sharers.size > 0
      ? await loadSharedListings(sharers, now, itemId)
      : [];
    const live = await buildCandidates(listings, sharers, null);
    if (!live.some((l) => l.itemId === itemId && !exclude.has(l.ownerId))) {
      return c.json({ error: "Not found" }, 404);
    }
    const { error } = await supabaseAdmin
      .from("reseller_swap_dismissals")
      .upsert({ user_id: ownerId, inventory_item_id: itemId }, {
        onConflict: "user_id,inventory_item_id",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`dismiss write: ${error.message}`);
    return c.json({ ok: true });
  } catch (e) {
    console.error("[flipdesk-swap]", (e as Error).message);
    return c.json({ error: "Could not dismiss tip" }, 500);
  }
});
