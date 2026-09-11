import { useQuery } from "@tanstack/react-query";
import { edgeApiUrl } from "@/lib/edge-api";
import type { GradeRanges } from "@/lib/grade-range";

// US-3339: the measured regrade spread per category, public and cached. A
// failed read means "no range", never an error on the page: the grade itself
// does not depend on it.
export function useGradeRanges() {
  return useQuery<GradeRanges>({
    queryKey: ["grade-ranges"],
    staleTime: 10 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`${edgeApiUrl()}/api/content/public/grade-ranges.json`);
      if (!res.ok) return {};
      const json = (await res.json().catch(() => ({}))) as { ranges?: GradeRanges };
      return json.ranges ?? {};
    },
  });
}
