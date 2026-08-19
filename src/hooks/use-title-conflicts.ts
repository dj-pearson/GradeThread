import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

/**
 * US-2677: does this draft read like one of the seller's OWN live listings?
 *
 * eBay penalises a whole store for near-duplicate listings rather than
 * rejecting the offending one, so the seller gets a slow store and no error
 * message anywhere. This is the only place they find out.
 *
 * Deliberately its own endpoint rather than the publish preflight: the seller
 * needs this while WRITING, and the preflight resolves business policies and
 * probes the category tree, none of which bears on whether two titles read
 * alike.
 */
export interface TitleConflict {
  listingId: string;
  title: string;
  /** 0..1 token overlap. */
  overlap: number;
  sharedTokens: string[];
  /** Wording the other listing owns and this one does not. */
  conflictOnlyTokens: string[];
}

export function useTitleConflicts(itemId: string | undefined) {
  return useQuery<TitleConflict[]>({
    queryKey: ["title_conflicts", itemId],
    enabled: !!itemId,
    // A duplicate warning does not change second to second, and the seller is
    // typing. Refetching on every focus would be a request per tab switch.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const res = await edgeFetch(`/api/flipdesk/listings/title-conflicts/${itemId}`);
      if (!res.ok) return [];
      const data = (await res.json().catch(() => ({}))) as { conflicts?: TitleConflict[] };
      return data.conflicts ?? [];
    },
  });
}
