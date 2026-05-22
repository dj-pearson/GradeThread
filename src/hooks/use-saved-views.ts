import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type { SavedViewRow } from "@/types/database";

export function useSavedViews() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["saved_views", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<SavedViewRow[]> => {
      const { data, error } = await supabase
        .from("flipdesk_saved_views")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SavedViewRow[];
    },
  });
}
