import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useWorkspace } from "@/hooks/use-workspace";
import type { SourceRow } from "@/types/database";

// SRC-1: RLS silently filters a write the caller may not make, so a 0-row
// UPDATE/DELETE comes back with no error. Say so instead of "Deleted".
export const NOTHING_CHANGED =
  "Nothing was changed. You may not have access, or it was already removed.";

// SRC-1: scoped to the ACTIVE workspace. This used to have no owner filter and
// key on user.id, so an owner who is also a member elsewhere got both tenants'
// sources (RLS admits both) in every picker, and could link an item in one
// workspace to a source in the other. Invalidate with the ["sources"] prefix.
export function useSources() {
  const { workspaceOwnerId } = useWorkspace();
  return useQuery({
    queryKey: ["sources", workspaceOwnerId],
    enabled: !!workspaceOwnerId,
    queryFn: async (): Promise<SourceRow[]> => {
      if (!workspaceOwnerId) return [];
      const { data, error } = await supabase
        .from("sources")
        .select("*")
        .eq("user_id", workspaceOwnerId)
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SourceRow[];
    },
  });
}
