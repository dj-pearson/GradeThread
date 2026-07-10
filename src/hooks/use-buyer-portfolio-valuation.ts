import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";

// US-1826: per-item current-value estimates + portfolio totals. Read-only; the
// edge caches + TTL-refreshes the valuation so a portfolio view never triggers a
// live Value Index scan.

export interface ItemValuation {
  closet_item_id: string;
  estimate_cents: number | null;
  low_cents: number | null;
  high_cents: number | null;
  confidence: "high" | "medium" | "low" | "none";
  basis: string[];
  cost_basis_cents: number | null;
  trend: "up" | "down" | "flat" | "unknown";
}

export interface PortfolioTotals {
  totalEstimateCents: number;
  costBasisCents: number;
  unrealizedGainCents: number;
  itemsValued: number;
  itemsUnvalued: number;
}

export function useBuyerPortfolioValuation() {
  const { user } = useAuth();
  const userId = user?.id;

  const query = useQuery<{ valuations: ItemValuation[]; totals: PortfolioTotals }>({
    queryKey: ["buyer-portfolio-valuation", userId],
    queryFn: async () => {
      const res = await edgeFetch("/api/buyer/closet/valuation", { skipWorkspaceHeader: true });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't value your portfolio.");
      return json as { valuations: ItemValuation[]; totals: PortfolioTotals };
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });

  const byItem = new Map<string, ItemValuation>();
  for (const v of query.data?.valuations ?? []) byItem.set(v.closet_item_id, v);

  return {
    totals: query.data?.totals ?? null,
    valuationFor: (closetItemId: string) => byItem.get(closetItemId) ?? null,
    isLoading: query.isLoading,
  };
}
