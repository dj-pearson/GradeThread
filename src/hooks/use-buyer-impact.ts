import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";

// US-1842: the buyer's circularity impact, aggregated across confirmed purchases
// (reuses the US-1785 methodology server-side — a labeled estimate).

export interface BuyerImpact {
  impact: {
    estimate: true;
    garment_count: number;
    co2e_kg: number;
    water_liters: number;
    landfill_kg: number;
    methodology: string;
  };
  confirmedItems: number;
}

export function useBuyerImpact() {
  const { user } = useAuth();
  const userId = user?.id;
  const query = useQuery<BuyerImpact>({
    queryKey: ["buyer-impact", userId],
    queryFn: async () => {
      const res = await edgeFetch("/api/buyer/impact", { skipWorkspaceHeader: true });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't load your impact.");
      return json as BuyerImpact;
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });
  return { data: query.data ?? null, isLoading: query.isLoading };
}
