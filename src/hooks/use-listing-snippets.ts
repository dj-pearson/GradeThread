// US-2961: the seller's snippets, read once and shared.
//
// Two readers so far — the settings page that edits them and the composer's
// description card, which needs the NAMES to label a snippet row and to tell a
// deleted reference from one it simply has not loaded yet. One query key for
// both, so renaming a snippet on the settings page relabels the composer's row
// without a reload.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  persistOrder,
  SNIPPETS_QUERY_KEY,
  updateSnippet,
} from "@/lib/flipdesk-snippets";
import type {
  ListingSnippetRow,
  ListingSnippetUpdate,
} from "@/types/database";

export interface UseListingSnippets {
  snippets: ListingSnippetRow[];
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  /** False until a fetch has settled — a ref missing from a list that has not
   *  loaded is not a deleted snippet, and the composer must not say it is. */
  loaded: boolean;
  refetch: () => void;
  create: (input: { name: string; body: string; sort_order: number }) => Promise<ListingSnippetRow>;
  update: (id: string, patch: ListingSnippetUpdate) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reorder: (rows: readonly ListingSnippetRow[]) => Promise<void>;
  isMutating: boolean;
}

export function useListingSnippets(): UseListingSnippets {
  const { user } = useAuth();
  const userId = user?.id;
  const qc = useQueryClient();
  const key = [...SNIPPETS_QUERY_KEY, userId];

  const query = useQuery<ListingSnippetRow[]>({
    queryKey: key,
    queryFn: () => listSnippets(userId!),
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const createM = useMutation({
    mutationFn: (input: { name: string; body: string; sort_order: number }) =>
      createSnippet({ user_id: userId!, ...input }),
    onSuccess: invalidate,
  });
  const updateM = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ListingSnippetUpdate }) =>
      updateSnippet(id, patch),
    onSuccess: invalidate,
  });
  const removeM = useMutation({
    mutationFn: (id: string) => deleteSnippet(id),
    onSuccess: invalidate,
  });
  const reorderM = useMutation({
    mutationFn: (rows: readonly ListingSnippetRow[]) => persistOrder(rows),
    onSuccess: invalidate,
  });

  return {
    snippets: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    loaded: query.isSuccess,
    refetch: () => void query.refetch(),
    create: (input) => createM.mutateAsync(input),
    update: (id, patch) => updateM.mutateAsync({ id, patch }),
    remove: (id) => removeM.mutateAsync(id),
    reorder: (rows) => reorderM.mutateAsync(rows),
    isMutating:
      createM.isPending || updateM.isPending || removeM.isPending || reorderM.isPending,
  };
}
