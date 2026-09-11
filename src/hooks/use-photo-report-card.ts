import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-3337: how the seller's photos have scored across their last grades. The
// edge aggregates it (GET /api/grade/photo-report-card) so the raw per-photo
// analysis never reaches the browser; this only carries counts and one tip.

export type PhotoSlot = "front" | "back" | "label" | "detail" | "defect" | "measurement";
export type PhotoProblem = "blur" | "lighting" | "framing" | "illegible";

export interface PhotoSlotReport {
  slot: PhotoSlot;
  photos: number;
  with_problems: number;
  problem_rate: number;
  problems: Record<PhotoProblem, { count: number; rate: number }>;
}

export interface PhotoReportCard {
  grades_counted: number;
  photos_measured: number;
  slots: PhotoSlotReport[];
  weakest: { slot: PhotoSlot; problem: PhotoProblem; rate: number; tip: string } | null;
}

export const PHOTO_REPORT_QUERY_KEY = ["photo-report-card"] as const;

export function usePhotoReportCard() {
  return useQuery<PhotoReportCard>({
    queryKey: PHOTO_REPORT_QUERY_KEY,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const res = await edgeFetch("/api/grade/photo-report-card");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
      return json as PhotoReportCard;
    },
  });
}
