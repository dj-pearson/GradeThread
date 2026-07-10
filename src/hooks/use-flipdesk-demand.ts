import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1831: seller-facing demand signal — aggregated PII-safe buyer wants.

export interface DemandFacet {
  term: string;
  wantCount: number;
  topMinGrade: number | null;
  topMaxPriceCents: number | null;
}

export interface DemandAggregate {
  brands: DemandFacet[];
  categories: DemandFacet[];
  totalWants: number;
}

export function useFlipdeskDemand() {
  const query = useQuery<DemandAggregate>({
    queryKey: ["flipdesk-demand"],
    queryFn: async () => {
      const res = await edgeFetch("/api/flipdesk/demand");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not load demand.");
      return json as DemandAggregate;
    },
    staleTime: 5 * 60 * 1000,
  });

  return { demand: query.data ?? null, isLoading: query.isLoading };
}
