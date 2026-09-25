import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { edgeFetch } from "@/lib/edge-fetch";
import { cn } from "@/lib/utils";
import {
  type ReferralEvent,
  referralStatusText,
  shortDate,
  sortReferralEvents,
} from "@/lib/referral-page";

// One row per referral, so a seller can see who is stuck before their first
// paid grade, who paid, and who can no longer pay. Rows come from
// GET /api/referrals/me/events, which classifies them with the same function as
// the stat tiles above, so the list and the tiles add up.

export function ReferralTimeline() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["referral-events"],
    queryFn: async (): Promise<{ events: ReferralEvent[]; truncated: boolean }> => {
      const res = await edgeFetch("/api/referrals/me/events");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load your referrals");
      return json;
    },
    staleTime: 60 * 1000,
  });

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load your referrals"
        onRetry={() => refetch()}
        retrying={isFetching}
        hideSupport
      />
    );
  }
  if (isLoading || !data) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (data.events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nobody has joined with your link yet. When they do, each one shows here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <ul className="divide-y">
        {sortReferralEvents(data.events).map((e) => (
          <li key={e.label} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="font-medium">{e.label}</p>
              <p className="text-xs text-muted-foreground">Joined {shortDate(e.joined_at)}</p>
            </div>
            <p
              className={cn(
                "text-right text-xs",
                e.status === "rewarded" ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {referralStatusText(e)}
            </p>
          </li>
        ))}
      </ul>
      {data.truncated && (
        <p className="text-xs text-muted-foreground">Showing your first 100 referrals.</p>
      )}
    </div>
  );
}
