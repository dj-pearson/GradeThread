import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import type { ClosetItemRow } from "@/types/database";

// US-1825: the owner's closet. READS go direct to Supabase under owner-read RLS;
// WRITES go through the edge (/api/buyer/closet) which verifies ownership of a
// linked certificate/passport before inserting. Manual entries need no link.

export interface AddClosetInput {
  source: ClosetItemRow["source"];
  certificate_id?: string;
  garment_id?: string;
  brand?: string | null;
  garment_type?: string | null;
  size?: string | null;
  condition_grade?: number | null;
  title?: string | null;
  notes?: string | null;
}

export function useBuyerCloset() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const key = ["buyer-closet", userId];

  const query = useQuery<ClosetItemRow[]>({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("closet_items")
        .select("*")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ClosetItemRow[];
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const addMutation = useMutation({
    mutationFn: async (input: AddClosetInput) => {
      const res = await edgeFetch("/api/buyer/closet", {
        method: "POST",
        json: input,
        skipWorkspaceHeader: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not add to your closet.");
      return json.item as ClosetItemRow;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  // US-1828: promote a closet item into FlipDesk inventory.
  const listMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/buyer/closet/${id}/list`, {
        method: "POST",
        json: {},
        skipWorkspaceHeader: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not list this item.");
      return json as { inventory_item_id: string; sellerOnboarding?: boolean; alreadyListed?: boolean };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/buyer/closet/${id}`, {
        method: "DELETE",
        skipWorkspaceHeader: true,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Could not remove the item.");
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return {
    items: query.data ?? [],
    isLoading: query.isLoading,
    // US-2026: expose the FAILURE. Without this the hook returns [] on
    // error, which consumers render as a confident empty state — a buyer
    // with 40 graded garments is told to "add your first item". A visible
    // error prompts a retry; a false empty state prompts the user to
    // conclude their data is gone.
    isError: query.isError,
    addItem: (input: AddClosetInput) => addMutation.mutateAsync(input),
    isAdding: addMutation.isPending,
    removeItem: (id: string) => removeMutation.mutateAsync(id),
    isRemoving: removeMutation.isPending,
    listItem: (id: string) => listMutation.mutateAsync(id),
    isListing: listMutation.isPending,
    // US-1828: download the insurance CSV (authed fetch → blob).
    exportCsv: async () => {
      const res = await edgeFetch("/api/buyer/closet/export.csv", { skipWorkspaceHeader: true });
      if (!res.ok) throw new Error("Could not export your closet.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gradethread-closet.csv";
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
