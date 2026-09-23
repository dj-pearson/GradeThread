// US-3458: turn eBay orphans into FlipDesk items without a click.
//
// An orphan is a live eBay listing the pull could not resolve to a local item
// (see buildEbaySkuIndex in routes/flipdesk-ebay.ts). Before this file every
// one of them waited in flipdesk_ebay_listings until the seller opened the
// Reconciliation page and pressed "Create all", and a seller who connected
// eBay to get their listings in never did, because nothing told them to.
//
// The decision is here and pure; the writes are below it and thin. The one
// judgement that matters is "is there already a FlipDesk item this listing
// belongs to?", and the answer has to be the SAME one the Reconciliation page
// gives (src/lib/ebay-reconcile.ts): an identical normalized title is a likely
// match, and a likely match is a question for the seller, never a merge and
// never a duplicate. Everything else becomes an item.

import { sanitizePulledAspects } from "./ebay-catalog-merge.ts";
import {
  type ItemCategory,
  itemCategoryFromEbayPath,
} from "./ebay-item-category.ts";
import { supabaseAdmin } from "./supabase.ts";
import { mirrorEbayPhotos } from "./ebay-photo-sync.ts";
import { ebayListingUrl, getCategoryName } from "./ebay-client.ts";
import type { CapacityHeadroom } from "./plan-gate.ts";

/**
 * Orphans adopted in one catalog pass. A pass with more waits for the next one
 * (six hours, CATALOG_REFRESH_MS) rather than spending thousands of writes in a
 * detached background task. Four queries per 200 orphans, so 1,000 is about
 * twenty queries, which is nothing next to the offer fan-out the same pass
 * already makes.
 */
export const MAX_ORPHAN_ADOPTIONS_PER_SYNC = 1000;

/**
 * How many orphans one pass may turn into items for this owner.
 *
 * An adopted orphan is a new inventory item in status 'listed', which is what
 * the activeListings cap counts, so adoption spends plan capacity exactly the
 * way a closet import does (routes/flipdesk-closet-import.ts). Before this the
 * sync adopted up to the per-pass bound with no reference to the plan at all:
 * a Free account connecting an eBay store of 400 listings came out of its
 * first pull holding 400 of 25 slots, without pressing anything.
 *
 * Trimmed rather than refused, like the closet import: the first `headroom`
 * orphans become items and the rest stay 'unmatched' in flipdesk_ebay_listings,
 * where the next pass picks them up if the seller frees a slot or upgrades.
 * An unknown allowance (the users row did not load) adopts nothing this pass;
 * that is never read as unlimited.
 */
export function orphanAdoptionCap(
  headroom: CapacityHeadroom | null,
  perPass: number = MAX_ORPHAN_ADOPTIONS_PER_SYNC,
): number {
  if (!headroom) return 0;
  if (headroom.headroom === null) return perPass;
  return Math.max(0, Math.min(perPass, headroom.headroom));
}

/** PostgREST sends `.in()` in the URL and a bulk insert in the body; both are chunked. */
const CHUNK = 200;

export interface OrphanCandidate {
  id: string;
  ebay_item_id: string;
  custom_label: string | null;
  title: string | null;
  current_price: number | null;
  available_quantity: number | null;
  listing_url: string | null;
  start_date: string | null;
  match_status: string;
  matched_item_id: string | null;
  photo_urls: string[] | null;
  raw: Record<string, unknown> | null;
}

export interface CatalogItemForAdoption {
  id: string;
  title: string | null;
  sku: string | null;
}

export type HoldReason = "title_match" | "sku_match";

export interface AdoptionPlan {
  /** Orphans that become a new item this pass. */
  adopt: OrphanCandidate[];
  /** Orphans with a likely local item: left for the seller to confirm. */
  held: Array<{ orphan: OrphanCandidate; itemId: string; reason: HoldReason }>;
  /** Adoptable orphans beyond the cap, deferred to the next pass. */
  deferred: number;
}

/** Same rule as src/lib/ebay-reconcile.ts, so both surfaces agree on "likely". */
export function normalizeTitle(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Same rule as src/lib/ebay-csv.ts normalizeSku. */
export function normalizeSku(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export function planOrphanAdoption(
  orphans: OrphanCandidate[],
  items: CatalogItemForAdoption[],
  cap: number = MAX_ORPHAN_ADOPTIONS_PER_SYNC,
): AdoptionPlan {
  const itemByTitle = new Map<string, string>();
  const itemBySku = new Map<string, string>();
  for (const it of items) {
    const title = normalizeTitle(it.title);
    if (title && !itemByTitle.has(title)) itemByTitle.set(title, it.id);
    const sku = normalizeSku(it.sku);
    if (sku && !itemBySku.has(sku)) itemBySku.set(sku, it.id);
  }

  const plan: AdoptionPlan = { adopt: [], held: [], deferred: 0 };
  for (const orphan of orphans) {
    // 'matched' is done and 'ignored' is the seller's own answer; neither is
    // ours to revisit. A matched_item_id with any status is a link too.
    if (orphan.match_status !== "unmatched" || orphan.matched_item_id) continue;

    // A Custom Label that IS a local SKU should have resolved in the pull. If it
    // reaches here the index disagreed with the catalog, and creating a second
    // item under a SKU the seller already uses is the worst available answer.
    const sku = normalizeSku(orphan.custom_label);
    const bySku = sku ? itemBySku.get(sku) : undefined;
    if (bySku) {
      plan.held.push({ orphan, itemId: bySku, reason: "sku_match" });
      continue;
    }
    const byTitle = itemByTitle.get(normalizeTitle(orphan.title));
    if (byTitle) {
      plan.held.push({ orphan, itemId: byTitle, reason: "title_match" });
      continue;
    }
    if (plan.adopt.length >= cap) {
      plan.deferred += 1;
      continue;
    }
    plan.adopt.push(orphan);
  }
  return plan;
}

export interface AdoptionItemRow {
  id: string;
  user_id: string;
  title: string;
  sku: string | null;
  status: "listed";
  target_price: number | null;
  /**
   * US-3468: the vertical eBay's category breadcrumb implies, "clothing" when
   * there is no breadcrumb to read. Until this every adopted item was a
   * garment, and a graded card came in with the clothing photo profile and
   * the garment measurement template around it.
   */
  item_category: ItemCategory;
  /**
   * US-3468: the listing's leaf category and full specifics, when the orphan
   * snapshot carried them (the modern pass puts product.aspects in `raw`).
   * Without these the new item had a title and photos and nothing a crosslist
   * draft could be built from. Omitted, not null, when absent, so the insert
   * leaves the column default alone and the next sync's GetItem fills it.
   */
  ebay_category_id?: string;
  ebay_aspects?: Record<string, string[]>;
}

export interface AdoptionListingRow {
  id: string;
  inventory_item_id: string;
  platform: "ebay";
  listing_origin: "ebay";
  platform_listing_id: string;
  listing_url: string;
  listing_price: number;
  listing_title: string | null;
  listing_status: "active";
  is_active: true;
  quantity: number | null;
  listed_at: string;
  platform_category_id: string | null;
}

/**
 * The two rows one adopted orphan becomes. Ids are minted here rather than read
 * back from the insert so a chunk of 200 items and their 200 listings can go in
 * as two statements, and so the photo mirror and the orphan flip can be planned
 * before anything is written.
 *
 * `usedSkus` is shared across the batch: eBay allows the same Custom Label on
 * two listings and inventory_items does not (idx_inventory_items_user_sku), so
 * the second listing with a repeated label is created without a SKU rather
 * than failing the whole chunk. The seller can set one on the item.
 */
export function buildAdoptionRows(
  orphan: OrphanCandidate,
  ownerId: string,
  now: string,
  usedSkus: Set<string>,
  mintId: () => string = () => crypto.randomUUID(),
  itemCategory: ItemCategory | null = null,
): { item: AdoptionItemRow; listing: AdoptionListingRow } {
  const itemId = mintId();
  const title = (orphan.title ?? "").trim() ||
    `eBay item ${orphan.ebay_item_id}`;
  const label = (orphan.custom_label ?? "").trim();
  let sku: string | null = null;
  if (label) {
    const key = label.toLowerCase();
    if (!usedSkus.has(key)) {
      usedSkus.add(key);
      sku = label;
    }
  }
  const categoryId = orphan.raw?.categoryId;
  const item: AdoptionItemRow = {
    id: itemId,
    user_id: ownerId,
    title,
    sku,
    status: "listed",
    target_price: orphan.current_price,
    item_category: itemCategory ?? "clothing",
  };
  if (typeof categoryId === "string" && categoryId.trim()) {
    item.ebay_category_id = categoryId.trim();
  }
  const aspects = sanitizePulledAspects(
    orphan.raw?.aspects as Record<string, unknown> | null | undefined,
  );
  if (Object.keys(aspects).length > 0) item.ebay_aspects = aspects;
  return {
    item,
    listing: {
      id: mintId(),
      inventory_item_id: itemId,
      platform: "ebay",
      // US-1077: a mirror of a live eBay listing is eBay-originated, which is
      // what keeps revise/end/relist refusing it and lets later pulls treat
      // eBay as the source of truth for its price and quantity.
      listing_origin: "ebay",
      platform_listing_id: orphan.ebay_item_id,
      listing_url: orphan.listing_url ?? ebayListingUrl(orphan.ebay_item_id),
      listing_price: orphan.current_price ?? 0,
      listing_title: orphan.title,
      listing_status: "active",
      is_active: true,
      quantity: orphan.available_quantity,
      // GetMyeBaySelling gives StartTime as a date; the offer pass gives none.
      listed_at: orphan.start_date ? `${orphan.start_date}T00:00:00.000Z` : now,
      platform_category_id: typeof categoryId === "string" ? categoryId : null,
    },
  };
}

export interface AdoptionResult {
  /** New inventory_items rows created. */
  adopted: number;
  /** Orphans that already had a listings row and were linked to it instead. */
  linked: number;
  /** item_photos reference rows written. */
  photos: number;
  /** Non-fatal problems, in the shape the sync's error list expects. */
  errors: string[];
}

/**
 * Writes the plan. US-268: `ownerId` is the connection owner the pull already
 * resolved, every insert carries it or a child id minted for it here, and the
 * one read that keys on ids from the orphan table joins back through
 * inventory_items.user_id.
 *
 * Idempotent by construction rather than by hope: an orphan whose eBay item id
 * already has a listings row for this owner is linked to that row's item, never
 * duplicated. That is the shape a crash between the listing insert and the
 * orphan flip leaves behind, and it is also what a manual link from the
 * Reconciliation page looks like, so the same branch covers both.
 */
/**
 * US-3468: eBay category id -> breadcrumb path, or null. The default reads
 * through the shared ebay_category_aspects cache (getCategoryName) and
 * resolves a miss live once, so a seller with 40 categories costs 40 lookups
 * on the first pass and none after. Injectable so the planner tests need no
 * eBay.
 */
export type CategoryPathResolver = (
  categoryId: string,
) => Promise<string | null>;

export const defaultCategoryPathResolver: CategoryPathResolver = async (id) => {
  try {
    return (await getCategoryName(id))?.path ?? null;
  } catch {
    return null;
  }
};

/**
 * The vertical for each distinct eBay category id among the orphans, resolved
 * once per id. A missing or unresolvable id maps to nothing, and the row then
 * takes the adoption default.
 */
export async function resolveItemCategories(
  orphans: OrphanCandidate[],
  resolve: CategoryPathResolver,
): Promise<Map<string, ItemCategory>> {
  const ids = new Set<string>();
  for (const o of orphans) {
    const id = o.raw?.categoryId;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  const out = new Map<string, ItemCategory>();
  for (const id of ids) {
    const category = itemCategoryFromEbayPath(await resolve(id));
    if (category) out.set(id, category);
  }
  return out;
}

function categoryIdOf(o: OrphanCandidate): string | null {
  const id = o.raw?.categoryId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export async function adoptOrphans(
  ownerId: string,
  adopt: OrphanCandidate[],
  now: string = new Date().toISOString(),
  resolveCategoryPath: CategoryPathResolver = defaultCategoryPathResolver,
): Promise<AdoptionResult> {
  const result: AdoptionResult = {
    adopted: 0,
    linked: 0,
    photos: 0,
    errors: [],
  };
  if (adopt.length === 0) return result;

  // 1. Which of these eBay ids already have a listing here? (crash recovery +
  //    manual links). One read per 200, owner-scoped through the parent.
  const alreadyListed = new Map<string, string>();
  for (let i = 0; i < adopt.length; i += CHUNK) {
    const ids = adopt.slice(i, i + CHUNK).map((o) => o.ebay_item_id);
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select(
        "platform_listing_id, inventory_item_id, inventory_items!inner(user_id)",
      )
      .eq("platform", "ebay")
      .eq("inventory_items.user_id", ownerId)
      .in("platform_listing_id", ids);
    if (error) {
      result.errors.push(
        `orphan adopt (existing read): ${error.message.slice(0, 160)}`,
      );
      return result;
    }
    for (
      const r of (data ?? []) as Array<
        { platform_listing_id: string | null; inventory_item_id: string | null }
      >
    ) {
      if (r.platform_listing_id && r.inventory_item_id) {
        alreadyListed.set(r.platform_listing_id, r.inventory_item_id);
      }
    }
  }

  const flips: Array<{
    user_id: string;
    ebay_item_id: string;
    matched_item_id: string;
    match_status: "matched";
  }> = [];
  const fresh: OrphanCandidate[] = [];
  for (const o of adopt) {
    const existingItem = alreadyListed.get(o.ebay_item_id);
    if (existingItem) {
      flips.push({
        user_id: ownerId,
        ebay_item_id: o.ebay_item_id,
        matched_item_id: existingItem,
        match_status: "matched",
      });
      result.linked += 1;
    } else {
      fresh.push(o);
    }
  }

  // 2. Create the rest, 200 at a time: items, then their listings, then the
  //    photo references, then the orphan flips. A failed chunk stops here with
  //    its orphans still 'unmatched', so the next pass retries them and step 1
  //    links whatever half-landed instead of duplicating it.
  const usedSkus = new Set<string>();
  // US-3468: one breadcrumb lookup per distinct category, before any write.
  const categoryByEbayId = await resolveItemCategories(fresh, resolveCategoryPath);
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const slice = fresh.slice(i, i + CHUNK);
    const rows = slice.map((o) => {
      const id = categoryIdOf(o);
      return buildAdoptionRows(
        o,
        ownerId,
        now,
        usedSkus,
        undefined,
        id ? categoryByEbayId.get(id) ?? null : null,
      );
    });

    const { error: itemErr } = await supabaseAdmin
      .from("inventory_items")
      .insert(rows.map((r) => r.item) as never);
    if (itemErr) {
      result.errors.push(
        `orphan adopt (items): ${itemErr.message.slice(0, 160)}`,
      );
      break;
    }
    const { error: listingErr } = await supabaseAdmin
      .from("listings")
      .insert(rows.map((r) => r.listing) as never);
    if (listingErr) {
      // The items exist and the orphans stay 'unmatched'. Step 1 cannot see
      // these items (no listing row), so say so loudly: the next pass would
      // create a second item for each. Rare, and the log names every id.
      result.errors.push(
        `orphan adopt (listings): ${
          listingErr.message.slice(0, 160)
        }; items created without listings: ${
          rows.map((r) => r.item.id).join(",")
        }`,
      );
      break;
    }

    const photoUrlsByItem = new Map<string, string[]>();
    for (let k = 0; k < slice.length; k += 1) {
      const urls = slice[k].photo_urls ?? [];
      if (urls.length > 0) photoUrlsByItem.set(rows[k].item.id, urls);
    }
    if (photoUrlsByItem.size > 0) {
      const mirror = await mirrorEbayPhotos(ownerId, photoUrlsByItem);
      result.photos += mirror.inserted;
      result.errors.push(...mirror.errors);
    }

    for (let k = 0; k < slice.length; k += 1) {
      flips.push({
        user_id: ownerId,
        ebay_item_id: slice[k].ebay_item_id,
        matched_item_id: rows[k].item.id,
        match_status: "matched",
      });
    }
    result.adopted += slice.length;
  }

  // 3. Flip the orphans. An upsert on the natural key updates only the columns
  //    carried, which is the same trick the pull uses to preserve a manual link
  //    (US-465 AC2), here used to write one.
  for (let i = 0; i < flips.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("flipdesk_ebay_listings")
      .upsert(flips.slice(i, i + CHUNK) as never, {
        onConflict: "user_id,ebay_item_id",
      });
    if (error) {
      result.errors.push(`orphan adopt (flip): ${error.message.slice(0, 160)}`);
      break;
    }
  }
  return result;
}
