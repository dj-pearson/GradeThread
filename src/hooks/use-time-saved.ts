import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import { currentMonth, type TimeSavedResponse } from "@/lib/time-saved";

// US-9207: the seller's time saved this month, summed by the server from the
// rows each automated task leaves behind. iOS and Android read the same route.

export function useTimeSaved(month: string = currentMonth()) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["time_saved", user?.id, month],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<TimeSavedResponse> => {
      const res = await edgeFetch(`/api/flipdesk/time-saved?month=${encodeURIComponent(month)}`);
      if (!res.ok) throw new Error("Could not load your time saved.");
      return (await res.json()) as TimeSavedResponse;
    },
  });
}
