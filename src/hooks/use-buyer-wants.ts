import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import type { BuyerWantRow } from "@/types/database";

// US-1830/1831: buyer "wants" — active demand broadcasts. Reads own via owner RLS;
// writes go through the edge (validated + matched server-side).

export interface CreateWantInput {
  brands?: string[];
  categories?: string[];
  keywords?: string[];
  min_grade?: number | null;
  max_price_cents?: number | null;
  size?: string | null;
  budget_cents?: number | null;
  visibility?: "public" | "private";
}

export function useBuyerWants() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const key = ["buyer-wants", userId];

  const query = useQuery<BuyerWantRow[]>({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("buyer_wants")
        .select("*")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as BuyerWantRow[];
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });

  const createMutation = useMutation({
    mutationFn: async (input: CreateWantInput) => {
      const res = await edgeFetch("/api/buyer/wants", { method: "POST", json: input, skipWorkspaceHeader: true });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not save your want.");
      return json as { want_id: string; matched: number };
    },
    onSuccess: invalidate,
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: BuyerWantRow["status"] }) => {
      const res = await edgeFetch(`/api/buyer/wants/${id}`, { method: "PATCH", json: { status }, skipWorkspaceHeader: true });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Update failed.");
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/buyer/wants/${id}`, { method: "DELETE", skipWorkspaceHeader: true });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Delete failed.");
    },
    onSuccess: invalidate,
  });

  return {
    wants: query.data ?? [],
    isLoading: query.isLoading,
    // US-2026: expose the FAILURE. Without this the hook returns [] on
    // error, which consumers render as a confident empty state — a buyer
    // with 40 graded garments is told to "add your first item". A visible
    // error prompts a retry; a false empty state prompts the user to
    // conclude their data is gone.
    isError: query.isError,
    createWant: (input: CreateWantInput) => createMutation.mutateAsync(input),
    isCreating: createMutation.isPending,
    setStatus: (id: string, status: BuyerWantRow["status"]) => statusMutation.mutateAsync({ id, status }),
    removeWant: (id: string) => deleteMutation.mutateAsync(id),
  };
}
