import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import type { SourcerRow } from "@/types/database";

// US-2886: the workspace's roster of people who source inventory.
//
// `inventory_items.sourced_by` is still a NAME string — this roster only decides
// which names the pickers offer. Real users of the workspace (the owner and
// everyone in workspace_members) are added to `sourcers` by the 00672 triggers,
// so the list is identical for every viewer regardless of what their own RLS
// lets them read out of `public.users`.

export interface SourcerOption {
  id: string;
  name: string;
  /** The workspace user this entry is, when it is one. */
  memberUserId: string | null;
  /** True when this entry is the signed-in person. */
  isYou: boolean;
}

/**
 * Shape the roster rows into picker options.
 *
 * "You" sorts first, then everyone else alphabetically: picking yourself is the
 * common case and shouldn't cost a scroll.
 */
export function toSourcerOptions(
  rows: SourcerRow[],
  userId: string | null,
): SourcerOption[] {
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      memberUserId: r.member_user_id,
      isYou: !!userId && r.member_user_id === userId,
    }))
    .sort((a, b) => {
      if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export function useSourcers(options?: { includeArchived?: boolean }) {
  const includeArchived = options?.includeArchived ?? false;
  const { workspaceOwnerId } = useWorkspace();
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const query = useQuery({
    queryKey: ["sourcers", workspaceOwnerId, includeArchived],
    enabled: !!workspaceOwnerId,
    queryFn: async (): Promise<SourcerRow[]> => {
      let q = supabase
        .from("sourcers")
        .select("*")
        .eq("user_id", workspaceOwnerId as string)
        .order("name", { ascending: true });
      if (!includeArchived) q = q.is("archived_at", null);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as SourcerRow[];
    },
  });

  const rows = useMemo(() => query.data ?? [], [query.data]);

  const sourcers = useMemo<SourcerOption[]>(
    () => toSourcerOptions(rows, userId),
    [rows, userId],
  );

  return { ...query, rows, sourcers };
}

/**
 * Add a name to the roster and return the name that should now be selected.
 *
 * A duplicate is not an error here: if the name already exists (the unique
 * index is case-insensitive), the existing entry's name is returned so the
 * caller selects it instead of showing a failure for a no-op.
 */
export function useAddSourcer() {
  const { workspaceOwnerId } = useWorkspace();
  const qc = useQueryClient();

  return useCallback(
    async (rawName: string): Promise<string> => {
      const name = rawName.trim();
      if (!name) throw new Error("Enter a name.");
      if (!workspaceOwnerId) throw new Error("No workspace.");

      const { data, error } = await supabase
        .from("sourcers")
        .insert({ user_id: workspaceOwnerId, name } as never)
        .select("name")
        .single();

      if (error) {
        // 23505 = the case-insensitive unique index. Fall back to whatever
        // spelling is already on the roster, including an archived one, and
        // un-archive it so the picker shows it again.
        if (error.code === "23505") {
          const { data: existing } = await supabase
            .from("sourcers")
            .select("id, name, archived_at")
            .eq("user_id", workspaceOwnerId)
            .ilike("name", name)
            .maybeSingle();
          const row = existing as
            | { id: string; name: string; archived_at: string | null }
            | null;
          if (row) {
            if (row.archived_at) {
              await supabase
                .from("sourcers")
                .update({ archived_at: null } as never)
                .eq("id", row.id);
            }
            await qc.invalidateQueries({ queryKey: ["sourcers"] });
            return row.name;
          }
        }
        throw error;
      }

      await qc.invalidateQueries({ queryKey: ["sourcers"] });
      return ((data as { name: string } | null)?.name ?? name);
    },
    [workspaceOwnerId, qc],
  );
}
