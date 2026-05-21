import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type { SourceRow } from "@/types/database";

export function useSources() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["sources", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<SourceRow[]> => {
      const { data, error } = await supabase
        .from("sources")
        .select("*")
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SourceRow[];
    },
  });
}
