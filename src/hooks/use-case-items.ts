import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// US-2521. A return row said "Return 5###### · opened 12 Mar" and nothing else.
// A cancellation said "Order 14-####". Both offer buttons that move money, and
// neither named the garment — so approving a refund meant opening eBay in
// another tab to find out what you were refunding.
//
// eBay hands back an order id and (for returns) its own item id. Both resolve to
// a local inventory item: the order id through `sales.platform_order_id`, the
// item id through `listings.platform_listing_id`. Two lookups, then one read for
// the titles and one for the cover photos.

export interface CaseItem {
  inventoryItemId: string;
  title: string | null;
  salePrice: number | null;
  /**
   * US-2932: what the seller paid for the garment. Needed to tell whether a
   * keep-it partial refund is cheaper than taking the return back, and null
   * when unknown — which is a refusal to suggest, not a zero.
   */
  acquiredPrice: number | null;
  thumbnailUrl: string | null;
  /** eBay's own item id, when the case carried one — used for the case link. */
  ebayItemId: string | null;
}

export interface CaseKey {
  orderId: string | null;
  itemId: string | null;
}

/** Key by order id first (a sale is the stronger signal), else by eBay item id. */
export function caseItemKey(key: CaseKey): string | null {
  return key.orderId ?? key.itemId ?? null;
}

async function chunked<T>(
  values: string[],
  size: number,
  run: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(...(await run(values.slice(i, i + size))));
  }
  return out;
}

/**
 * Resolves eBay return and cancellation rows to the garment each is about.
 * RLS scopes every read to the caller, so nothing here needs a tenant filter.
 */
export function useCaseItems(keys: CaseKey[]) {
  const orderIds = [...new Set(keys.map((k) => k.orderId).filter(Boolean))] as string[];
  const itemIds = [...new Set(keys.map((k) => k.itemId).filter(Boolean))] as string[];

  return useQuery({
    // Sorted, so the same set in a different order is the same cache entry.
    queryKey: ["case_items", [...orderIds].sort(), [...itemIds].sort()],
    enabled: orderIds.length > 0 || itemIds.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, CaseItem>> => {
      const byKey = new Map<string, CaseItem>();
      const inventoryIds = new Set<string>();

      // 1. Order id → the sale, which carries the price actually paid.
      if (orderIds.length > 0) {
        const sales = await chunked(orderIds, 50, async (chunk) => {
          const { data, error } = await supabase
            .from("sales")
            .select("inventory_item_id, sale_price, platform_order_id")
            .in("platform_order_id", chunk);
          if (error) throw error;
          return ((data ?? []) as unknown) as {
            inventory_item_id: string | null;
            sale_price: number | null;
            platform_order_id: string | null;
          }[];
        });
        for (const s of sales) {
          if (!s.platform_order_id || !s.inventory_item_id) continue;
          inventoryIds.add(s.inventory_item_id);
          byKey.set(s.platform_order_id, {
            inventoryItemId: s.inventory_item_id,
            title: null,
            salePrice: s.sale_price,
            acquiredPrice: null,
            thumbnailUrl: null,
            ebayItemId: null,
          });
        }
      }

      // 2. eBay item id → the listing, for cases with no matched sale row yet.
      if (itemIds.length > 0) {
        const listings = await chunked(itemIds, 50, async (chunk) => {
          const { data, error } = await supabase
            .from("listings")
            .select("inventory_item_id, platform_listing_id")
            .eq("platform", "ebay")
            .in("platform_listing_id", chunk);
          if (error) throw error;
          return ((data ?? []) as unknown) as {
            inventory_item_id: string | null;
            platform_listing_id: string | null;
          }[];
        });
        for (const l of listings) {
          if (!l.platform_listing_id || !l.inventory_item_id) continue;
          inventoryIds.add(l.inventory_item_id);
          const existing = byKey.get(l.platform_listing_id);
          byKey.set(l.platform_listing_id, {
            inventoryItemId: l.inventory_item_id,
            title: null,
            salePrice: existing?.salePrice ?? null,
            acquiredPrice: null,
            thumbnailUrl: null,
            ebayItemId: l.platform_listing_id,
          });
        }
      }

      if (inventoryIds.size === 0) return byKey;
      const ids = [...inventoryIds];

      // 3. Titles.
      const items = await chunked(ids, 50, async (chunk) => {
        const { data, error } = await supabase
          .from("inventory_items")
          .select("id, title, acquired_price")
          .in("id", chunk);
        if (error) throw error;
        return ((data ?? []) as unknown) as {
          id: string;
          title: string | null;
          acquired_price: number | null;
        }[];
      });
      const titleById = new Map(items.map((i) => [i.id, i.title]));
      const costById = new Map(items.map((i) => [i.id, i.acquired_price]));

      // 4. Cover photos. The lowest sort_order row per item is the cover, and
      // chunking is BY ITEM ID so an item's photos never span two chunks.
      const photos = await chunked(ids, 50, async (chunk) => {
        const { data, error } = await supabase
          .from("item_photos")
          .select("inventory_item_id, thumbnail_url, photo_url, sort_order")
          .in("inventory_item_id", chunk)
          .order("sort_order", { ascending: true });
        if (error) throw error;
        return ((data ?? []) as unknown) as {
          inventory_item_id: string | null;
          thumbnail_url: string | null;
          photo_url: string | null;
        }[];
      });
      const coverById = new Map<string, string | null>();
      for (const p of photos) {
        if (!p.inventory_item_id || coverById.has(p.inventory_item_id)) continue;
        coverById.set(p.inventory_item_id, p.thumbnail_url ?? p.photo_url);
      }

      for (const [key, entry] of byKey) {
        byKey.set(key, {
          ...entry,
          title: titleById.get(entry.inventoryItemId) ?? null,
          acquiredPrice: costById.get(entry.inventoryItemId) ?? null,
          thumbnailUrl: coverById.get(entry.inventoryItemId) ?? null,
        });
      }
      return byKey;
    },
  });
}

/** The eBay case URL a seller expects "open on eBay" to go to. */
export function ebayReturnUrl(returnId: string): string {
  return `https://returns.ebay.com/ws/eBayISAPI.dll?ReturnDetails&returnId=${encodeURIComponent(returnId)}`;
}

export function ebayOrderUrl(orderId: string): string {
  return `https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(orderId)}`;
}
