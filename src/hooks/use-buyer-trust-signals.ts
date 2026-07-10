import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";

// US-1844: the coarse public trust signals for a set of certificate ids, so any
// buyer surface (portfolio, alerts, watchlist) can render the SAME verified
// badges the public cert page shows and deep-link to the full certificate.
// Reuses the server-side public projection — never an internal signal.

export interface TrustBadge {
  key: string;
  label: string;
}

export interface CertTrustSignals {
  badges: TrustBadge[];
  hasAny: boolean;
  certUrl: string;
}

const EMPTY: Record<string, CertTrustSignals> = {};

export function useBuyerTrustSignals(certIds: Array<string | null | undefined>) {
  const { user } = useAuth();
  const userId = user?.id;
  // Stable, deduped, sorted key so the query only refires on a real set change.
  const ids = [...new Set(certIds.filter((x): x is string => !!x))].sort();
  const query = useQuery<Record<string, CertTrustSignals>>({
    queryKey: ["buyer-trust-signals", userId, ids.join(",")],
    queryFn: async () => {
      const res = await edgeFetch("/api/buyer/trust-signals", {
        method: "POST",
        skipWorkspaceHeader: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certIds: ids }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't load trust signals.");
      return (json.signals ?? {}) as Record<string, CertTrustSignals>;
    },
    enabled: !!userId && ids.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  return { signals: query.data ?? EMPTY, isLoading: query.isLoading };
}
