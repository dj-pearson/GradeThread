import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-909: per-admin saved views for the admin list pages. Backed by the
// /api/admin/views endpoints (admin JWT + AAL2), scoped server-side to the
// calling admin so views are private.

export interface AdminSavedView {
  id: string;
  surface: string;
  name: string;
  filter: Record<string, unknown>;
  created_at: string;
}

export function useAdminSavedViews(surface: string) {
  return useQuery({
    queryKey: ["admin-saved-views", surface],
    queryFn: async (): Promise<AdminSavedView[]> => {
      const res = await edgeFetch(
        `/api/admin/views?surface=${encodeURIComponent(surface)}`,
        { silentGate: true },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load saved views");
      return (json.views ?? []) as AdminSavedView[];
    },
    staleTime: 60_000,
  });
}
