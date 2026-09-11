import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import type { GradeTierKey } from "@/lib/constants";
import type { LiveTurnaround } from "@/lib/grading-journey";

// US-3328: the live turnaround (pricing-config hours, whether the release hold
// is on) and when each of the caller's held grades will be ready.
//
// Held grades are invisible to direct reads until release (RLS, 00786), so
// this server call is the only way a page can know one exists and when it
// lands. A failed or pending request returns an empty result, and every
// caller then renders what it rendered before US-3328.

export interface GradeTurnaround {
  live: LiveTurnaround | undefined;
  /** submission_id -> ISO release time, for held grades only. */
  releaseTimes: Record<string, string>;
}

interface TurnaroundResponse {
  sla_hours?: Partial<Record<GradeTierKey, number>>;
  hold_enabled?: boolean;
  release_times?: Record<string, string>;
}

export function useGradeTurnaround(enabled = true): GradeTurnaround {
  const { data } = useQuery({
    queryKey: ["grade-turnaround"],
    enabled,
    queryFn: async (): Promise<TurnaroundResponse> => {
      const res = await edgeFetch("/api/grade/turnaround");
      if (!res.ok) return {};
      return (await res.json().catch(() => ({}))) as TurnaroundResponse;
    },
    staleTime: 60 * 1000,
    retry: 0,
  });
  return {
    live: data
      ? { holdEnabled: data.hold_enabled === true, slaHours: data.sla_hours }
      : undefined,
    releaseTimes: data?.release_times ?? {},
  };
}

/** "Sep 12, 3:00 PM" in the viewer's locale. */
export function formatReadyBy(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
