import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { useNeedsYou } from "@/hooks/use-needs-you";
import { useSyncConflicts } from "@/hooks/use-sync-conflicts";
import { useExtensionQueue } from "@/hooks/use-extension-queue";
import { useAutolisterDrafts } from "@/hooks/use-autolister";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { deadlineLabel } from "@/pages/flipdesk/post-sale-state";
import { widgetsForSurface, type DashboardSurface } from "@/lib/dashboard-widgets";
import {
  DEFAULT_OVERVIEW_RANGE,
  type OverviewRangeId,
} from "@/lib/overview-range";
import {
  ALL_CLEAR,
  buildAttentionChips,
  oldestUpdatedAt,
  type AttentionChip,
} from "@/lib/attention-rail";

// US-3079: one line above both overviews saying what needs the seller now.
//
// NOT A WIDGET, deliberately. Every other block on these pages can be hidden,
// moved or resized, and this one cannot, because a rail a seller can hide is a
// rail that stops being trustworthy: "nothing needs me" has to mean the same
// thing on every account. It renders between PageHeader and the board rather
// than inside the grid for the same reason.
//
// The ordering rule and the all-clear case live in src/lib/attention-rail.ts,
// where they are tested as data. This file is the wiring: which hook feeds which
// count, and what to show while they are still arriving.

/** Statuses that stall a submission until a person acts. Mirrors ATTENTION_STATUSES. */
const GRADING_STATUS = {
  inReview: "pending_review",
  failed: "failed",
  disputed: "disputed",
} as const;

/**
 * Counts, not rows.
 *
 * The grading attention WIDGET caps its read at five rows because it renders a
 * list; the rail needs the real total, and "5+" in a rail is a worse answer than
 * a number. `head: true` with an exact count asks Postgres for the number and
 * transfers no rows.
 */
function useGradingAttentionCounts(enabled: boolean) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["attention-rail-grading", user?.id],
    enabled: enabled && !!user,
    staleTime: 60_000,
    queryFn: async () => {
      const one = async (status: string) => {
        const { count, error } = await supabase
          .from("submissions")
          .select("id", { count: "exact", head: true })
          .is("superseded_at", null)
          .eq("status", status);
        if (error) throw error;
        return count ?? 0;
      };
      const [inReview, failed, disputed] = await Promise.all([
        one(GRADING_STATUS.inReview),
        one(GRADING_STATUS.failed),
        one(GRADING_STATUS.disputed),
      ]);
      return { inReview, failed, disputed };
    },
  });
}

/** "Updated 4 minutes ago", or null when nothing has resolved yet. */
function relativeTime(at: number | null, now: number): string | null {
  if (at == null) return null;
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export interface AttentionRailProps {
  surface: DashboardSurface;
  /**
   * The board's reporting window, so the aging and stale counts come off the
   * SAME flipdesk_overview_metrics read the widgets use instead of issuing a
   * second one. Same range, same query key, same cache entry: the epic's
   * standing constraint is one aggregate RPC for the board, and a rail with its
   * own copy would quietly make it two.
   */
  range?: OverviewRangeId;
  className?: string;
}

export function AttentionRail(
  { surface, range = DEFAULT_OVERVIEW_RANGE, className }: AttentionRailProps,
) {
  const isFlipdesk = surface === "flipdesk";
  const queryClient = useQueryClient();

  const needsYou = useNeedsYou(isFlipdesk);
  const conflicts = useSyncConflicts();
  const queue = useExtensionQueue(isFlipdesk);
  const drafts = useAutolisterDrafts(isFlipdesk);
  const overview = useFlipdeskOverview(range);
  const grading = useGradingAttentionCounts(!isFlipdesk);

  const chips = useMemo<AttentionChip[]>(() => {
    // The soonest deadline is the FIRST item's, because useNeedsYou returns the
    // list already ranked deadline-first. Re-sorting here would be a second
    // ranking rule to keep in step with the first.
    const soonest = needsYou.items[0]?.deadline ?? null;
    return buildAttentionChips({
      surface: isFlipdesk ? "flipdesk" : "grading",
      flipdesk: isFlipdesk
        ? {
          needsYouCount: needsYou.items.length,
          needsYouDeadlineLabel: deadlineLabel(soonest),
          // A capped read: `rows` is at most `limit`, so on a very large
          // backlog this is a FLOOR rather than the total. Shown anyway
          // because the chip is a prompt to go and look, and the page it
          // links to has the real number.
          draftsToReview: drafts.data?.rows.length ?? 0,
          syncConflicts: conflicts.data?.total ?? 0,
          extensionJobsPending: queue.data?.pending.length ?? 0,
          agingCount: overview.data?.agingCount ?? 0,
          staleCount: overview.data?.staleCount ?? 0,
        }
        : null,
      grading: !isFlipdesk
        ? {
          inReview: grading.data?.inReview ?? 0,
          failed: grading.data?.failed ?? 0,
          disputed: grading.data?.disputed ?? 0,
        }
        : null,
    });
  }, [
    isFlipdesk,
    needsYou.items,
    drafts.data,
    conflicts.data,
    queue.data,
    overview.data,
    grading.data,
  ]);

  const sources = isFlipdesk
    ? [conflicts, queue, drafts, overview]
    : [grading];
  const updatedAt = oldestUpdatedAt(sources.map((q) => q.dataUpdatedAt ?? 0));
  const updatedLabel = relativeTime(updatedAt, Date.now());
  const loading = sources.some((q) => q.isLoading) ||
    (isFlipdesk && needsYou.isLoading);
  const refreshing = sources.some((q) => q.isFetching) ||
    (isFlipdesk && needsYou.isFetching);

  /**
   * Refresh everything the board reads, by invalidating the queryKey prefixes
   * the registry declares — not a hand-kept list here. A widget added later is
   * refreshed by this control on the commit that registers it, with no edit to
   * this file, which is the only version of "refresh all" that stays true.
   */
  const refreshAll = () => {
    const prefixes = new Set<string>();
    for (const w of widgetsForSurface(surface)) {
      for (const k of w.queryKeys) prefixes.add(k);
    }
    for (const p of prefixes) {
      void queryClient.invalidateQueries({ queryKey: [p] });
    }
    if (isFlipdesk) needsYou.refetch();
  };

  return (
    <div
      // Border only: elevation is declared once, and a rail with both a border
      // and a shadow is one of the tells npm run ui:check gates on.
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3",
        className,
      )}
      role="region"
      aria-label="Needs your attention"
    >
      {loading
        ? (
          <span className="text-sm text-muted-foreground">
            Checking what needs you…
          </span>
        )
        : chips.length === 0
        ? <span className="text-sm font-medium">{ALL_CLEAR}</span>
        : (
          chips.map((chip) => (
            <Link
              key={chip.id}
              to={chip.href}
              className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="font-semibold tabular-nums">{chip.count}</span>
              <span>{chip.label}</span>
              {chip.hint
                ? (
                  <span className="text-muted-foreground">
                    · {chip.hint}
                  </span>
                )
                : null}
            </Link>
          ))
        )}

      <div className="ml-auto flex items-center gap-2">
        {updatedLabel
          ? (
            <span className="text-xs text-muted-foreground">
              Updated {updatedLabel}
            </span>
          )
          : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={refreshAll}
          disabled={refreshing}
        >
          <RefreshCw
            className={cn("h-4 w-4", refreshing && "animate-spin")}
            aria-hidden="true"
          />
          <span className="sr-only sm:not-sr-only sm:ml-2">Refresh</span>
        </Button>
      </div>
    </div>
  );
}
