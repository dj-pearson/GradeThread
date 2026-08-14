import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { useBuyerPreferences } from "@/hooks/use-buyer-preferences";
import { newSavedSearchFromPreferences, type SavedSearchCriteria } from "@/lib/watchlist";
import type { SavedSearchRow, SavedSearchUpdate } from "@/types/database";

// US-1806: the buyer's saved searches — standing criteria the matching engine
// (US-1807) sweeps against newly-graded inventory. Owner-managed straight to
// Supabase under RLS; the edge reads via the service-role client scoped by
// user_id (US-268). New searches SEED from buyer preferences (US-1798) but are
// then independently editable (the seed is a snapshot, not a live binding).

export interface UseSavedSearches {
  searches: SavedSearchRow[];
  isLoading: boolean;
  isError: boolean;
  /** US-2508: so a consumer's ErrorState can retry the query instead of reloading the page. */
  isFetching: boolean;
  refetch: () => void;
  /**
   * Create a new search, defaulting criteria from buyer preferences. `criteria`
   * overrides those defaults field by field — used by the US-1843 claim, where
   * the visitor already stated the item, the condition floor and the price, so
   * seeding from preferences instead would throw their answer away.
   */
  create: (
    label?: string,
    criteria?: Partial<SavedSearchCriteria>,
  ) => Promise<SavedSearchRow>;
  /** Patch a search's criteria / notify flags / active state. */
  update: (id: string, patch: SavedSearchUpdate) => Promise<SavedSearchRow>;
  remove: (id: string) => Promise<void>;
  isMutating: boolean;
}

export function useSavedSearches(): UseSavedSearches {
  const { user } = useAuth();
  const { preferences } = useBuyerPreferences();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const key = ["saved-searches", userId];

  const query = useQuery<SavedSearchRow[]>({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("saved_searches")
        .select("*")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SavedSearchRow[];
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const createMutation = useMutation({
    mutationFn: async ({
      label,
      criteria,
    }: { label?: string; criteria?: Partial<SavedSearchCriteria> }) => {
      const insert = {
        ...newSavedSearchFromPreferences(userId!, preferences, label ?? "Saved search"),
        ...(criteria ?? {}),
      };
      const { data, error } = await supabase
        .from("saved_searches")
        // `as never`: tsc -b project-reference quirk (Insert resolves to never).
        .insert(insert as never)
        .select("*")
        .single();
      if (error) throw error;
      return data as SavedSearchRow;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: SavedSearchUpdate }) => {
      // NOTE (US-1552): plain `.eq` chain only — never `.or()` on a mutation.
      const { data, error } = await supabase
        .from("saved_searches")
        .update(patch as never)
        .eq("user_id", userId!)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return data as SavedSearchRow;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("saved_searches")
        .delete()
        .eq("user_id", userId!)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return {
    searches: query.data ?? [],
    isLoading: query.isLoading,
    // US-2026: expose the FAILURE. Without this the hook returns [] on
    // error, which consumers render as a confident empty state — a buyer
    // with 40 graded garments is told to "add your first item". A visible
    // error prompts a retry; a false empty state prompts the user to
    // conclude their data is gone.
    isError: query.isError,
    // US-2508: a retry needs something to call. Without these the consumer's
    // ErrorState fell back to window.location.reload(), which throws away
    // whatever the buyer had typed on the page.
    isFetching: query.isFetching,
    refetch: query.refetch,
    create: (label, criteria) => createMutation.mutateAsync({ label, criteria }),
    update: (id, patch) => updateMutation.mutateAsync({ id, patch }),
    remove: (id) => removeMutation.mutateAsync(id),
    isMutating:
      createMutation.isPending || updateMutation.isPending || removeMutation.isPending,
  };
}
