import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1864: Thrift Radar's personal layer — "my stores".
//
// This is the free, cold-start half of Radar (rule 7 in
// vault/20-domain/thrift-radar.md): the reseller's OWN sourcing history per
// store, computed from their sources, items and sales, enriched with the visits
// their Prospect scans recorded. It needs no contribution consent, no plan and no
// network data, so this hook deliberately has no gate of its own — the endpoint
// has none either, and adding one here would put a paywall on the surface whose
// job is to be useful before anyone has paid for anything.

export type PersonalStoreSort =
  | "roi"
  | "realized_roi"
  | "profit"
  | "spend"
  | "items"
  | "visits"
  | "recent"
  | "name";

export interface PersonalStoreBrand {
  brand: string;
  items: number;
  realized_profit_cents: number;
}

export interface PersonalStore {
  key: string;
  source_id: string | null;
  venue_id: string | null;
  name: string;
  source_type: string | null;
  location: string | null;
  chain: string | null;
  /**
   * The linked venue's coordinates (US-1865), so this store can be drawn on the
   * Radar map. Null for a source nobody has joined to a place — which is why
   * the map keeps an "not on the map" list beside it rather than dropping them.
   */
  lat: number | null;
  lng: number | null;
  linked: boolean;
  items_sourced: number;
  items_sold: number;
  spend_cents: number;
  sold_spend_cents: number;
  realized_profit_cents: number;
  expected_profit_cents: number;
  roi_pct: number | null;
  realized_roi_pct: number | null;
  sell_through_pct: number | null;
  top_brands: PersonalStoreBrand[];
  visits: number;
  buy_visits: number;
  last_visit_at: string | null;
  last_visit_source: "purchase" | "scan" | null;
}

export interface PersonalStoresPayload {
  sort: PersonalStoreSort;
  stores: PersonalStore[];
  unplaced_visits: number;
  unattributed_items: number;
  truncated: boolean;
}

export function useRadarStores(sort: PersonalStoreSort) {
  return useQuery<PersonalStoresPayload>({
    queryKey: ["radar_my_stores", sort],
    queryFn: async () => {
      const res = await edgeFetch(
        `/api/flipdesk/radar/my-stores?sort=${encodeURIComponent(sort)}`,
      );
      const data = (await res.json().catch(() => ({}))) as
        & Partial<PersonalStoresPayload>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load your stores");
      return {
        sort: data.sort ?? sort,
        stores: data.stores ?? [],
        unplaced_visits: data.unplaced_visits ?? 0,
        unattributed_items: data.unattributed_items ?? 0,
        truncated: data.truncated ?? false,
      };
    },
  });
}

export interface LinkStoreInput {
  sourceId: string;
  /** Null unlinks. */
  venueId: string | null;
}

export function useLinkRadarStore() {
  const qc = useQueryClient();
  return useMutation<{ venue_id: string | null }, Error, LinkStoreInput>({
    mutationFn: async ({ sourceId, venueId }) => {
      const res = await edgeFetch("/api/flipdesk/radar/my-stores/link", {
        method: "POST",
        json: { source_id: sourceId, venue_id: venueId },
      });
      const data = (await res.json().catch(() => ({}))) as {
        venue_id?: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to link that store");
      return { venue_id: data.venue_id ?? null };
    },
    onSuccess: (result) => {
      // Both the ranking and the Sources list carry the link, so both go stale.
      void qc.invalidateQueries({ queryKey: ["radar_my_stores"] });
      void qc.invalidateQueries({ queryKey: ["sources"] });
      toast.success(
        result.venue_id
          ? "Linked — your scans at that store now count toward its numbers."
          : "Unlinked. Your items and spend for that store are unchanged.",
      );
    },
    onError: (err) => toastError(err),
  });
}
