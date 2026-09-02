import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { GarmentRow } from "@/types/database";

// US-3075: the seller's own Garment Passports, read once for the two widgets
// that report on them (grading.passports and grading.discover).
//
// US-1118 put this query in dashboard.tsx to feed one Discover card. Two
// widgets need it now and neither owns the other, so it moved here rather than
// being copied: one query key, one cache entry, one read.

export interface PassportSummary {
  count: number;
  latestSlug: string | null;
}

export function usePassportSummary() {
  return useQuery<PassportSummary>({
    queryKey: ["dashboard-passports"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // RLS scopes `garments` to created_by = auth.uid(), so this returns only
      // passports this account created.
      const { data, count, error } = await supabase
        .from("garments")
        .select("public_passport_slug", { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(1);
      // US-1636: surface the failure rather than reporting zero passports.
      if (error) throw error;
      const rows = (data ?? []) as unknown as Pick<
        GarmentRow,
        "public_passport_slug"
      >[];
      return { count: count ?? 0, latestSlug: rows[0]?.public_passport_slug ?? null };
    },
  });
}
