import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import type { BuyerTrustScoreRow } from "@/types/database";

// US-1817: read the buyer's derived Trust Score (buyer_trust_scores, 00417).
// Owner-read RLS — a buyer sees only their own score; the score is written by
// the edge recompute (US-1816), never the client. Null until the buyer has any
// reputation events (treated as level 0 "New" by the UI).

export function useBuyerTrustScore() {
  const { user } = useAuth();
  const userId = user?.id;

  const query = useQuery<BuyerTrustScoreRow | null>({
    queryKey: ["buyer-trust-score", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("buyer_trust_scores")
        .select("*")
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });

  return {
    trustScore: query.data ?? null,
    /** Effective level (0 "New" when the buyer has no score row yet). */
    level: query.data?.level ?? 0,
    score: query.data?.score ?? 0,
    isLoading: query.isLoading,
  };
}
