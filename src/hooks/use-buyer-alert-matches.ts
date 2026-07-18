import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import type { NotificationRow } from "@/types/database";

// US-1809: the buyer's recent condition-alert MATCHES — the in-app feed rows the
// matching engine (US-1807) emitted via notifyBuyer (type buyer_condition_alert).
// Reads the shared notifications table under RLS (owner-only), filtered to the
// condition-alert type so the alerts dashboard shows matches without the rest of
// the notification noise.

const CONDITION_ALERT_TYPE = "buyer_condition_alert" as const;

export interface UseBuyerAlertMatches {
  matches: NotificationRow[];
  isLoading: boolean;
  isError: boolean;
  /** Mark a single match read (dismiss its unread dot). */
  markRead: (id: string) => Promise<void>;
}

export function useBuyerAlertMatches(limit = 30): UseBuyerAlertMatches {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const key = ["buyer-alert-matches", userId];

  const query = useQuery<NotificationRow[]>({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", userId!)
        .eq("type", CONDITION_ALERT_TYPE)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as NotificationRow[];
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true } as never)
        .eq("id", id)
        .eq("user_id", userId!);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return {
    matches: query.data ?? [],
    isLoading: query.isLoading,
    // US-2026: expose the FAILURE. Without this the hook returns [] on
    // error, which consumers render as a confident empty state — a buyer
    // with 40 graded garments is told to "add your first item". A visible
    // error prompts a retry; a false empty state prompts the user to
    // conclude their data is gone.
    isError: query.isError,
    markRead: (id) => markReadMutation.mutateAsync(id),
  };
}
