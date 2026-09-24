import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { useNeedsYou } from "@/hooks/use-needs-you";
import { useEbayConnection } from "@/hooks/use-ebay";
import { useSyncConflicts } from "@/hooks/use-sync-conflicts";
import { useExtensionQueue } from "@/hooks/use-extension-queue";
import { useAutolisterDrafts } from "@/hooks/use-autolister";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { deadlineLabel } from "@/pages/flipdesk/post-sale-state";
import {
  ATTENTION_STATUSES,
  tallySubmissionStatuses,
} from "@/lib/dashboard-grading-queue";
import { widgetsForSurface, type DashboardSurface } from "@/lib/dashboard-widgets";
import {
  DEFAULT_OVERVIEW_RANGE,
  type OverviewRangeId,
} from "@/lib/overview-range";
import {
  ALL_CLEAR,
  buildAttentionChips,
  isPlanGateError,
  oldestUpdatedAt,
  RAIL_QUERY_KEYS,
  railState,
  type AttentionChip,
  type AttentionSurface,
} from "@/lib/attention-rail";
import { personaOf } from "@/lib/dashboard-layout";
import { availableOverviewViews } from "@/lib/overview-view";

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

/**
 * Counts, not rows to render.
 *
 * ONE request for every attention status, tallied here: separate head counts
 * were one round trip per status and could disagree with each other when a
 * submission moved between two of them. The read selects only `status`, over
 * rows RLS has already scoped to the account.
 */
function useGradingAttentionCounts(enabled: boolean) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: [RAIL_QUERY_KEYS[0], user?.id],
    enabled: enabled && !!user,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("status")
        .is("superseded_at", null)
        .in("status", ATTENTION_STATUSES as unknown as string[]);
      if (error) throw error;
      const counts = tallySubmissionStatuses(
        (data ?? []) as { status: string | null }[],
      );
      return {
        needsPhotos: counts.needs_photos,
        inReview: counts.pending_review,
        failed: counts.failed,
        disputed: counts.disputed,
      };
    },
  });
}

/**
 * The current time, re-read every `ms`. Without it "Updated just now" is
 * computed once per render and never advances while the page sits open.
 */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
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
  // The rail renders on the two Overview boards. Any other surface (ios-home
  // is a layout the iOS app reads, never a web board) gets no rail, decided
  // here rather than by falling through to the grading branch.
  const railSurface: AttentionSurface | null =
    surface === "flipdesk" ? "flipdesk" : surface === "grading" ? "grading" : null;
  const isFlipdesk = railSurface === "flipdesk";
  const isGrading = railSurface === "grading";
  const queryClient = useQueryClient();

  // Which halves of the Overview this account has, for the cross-surface chip.
  const useCase = useAuthStore((s) => s.profile?.use_case);
  const views = availableOverviewViews(personaOf(useCase));
  const hasGrading = views.some((v) => v.id === "grading");
  const hasFlipdesk = views.some((v) => v.id === "flipdesk");

  // The six eBay queues each 502 for a seller with no eBay connection, which
  // would read as "Could not check eBay queues" on every load. Ask eBay only
  // when there is a connection (or when the connection read itself failed).
  const ebay = useEbayConnection();
  const ebayOn = isFlipdesk && !ebay.isLoading && (ebay.isError || !!ebay.data);
  // DASH-14: on the grading view, a seller with FlipDesk and a live eBay
  // connection also gets the needs-you total, for one trailing chip.
  const crossNeedsYou = isGrading && hasFlipdesk && !!ebay.data;
  const needsYou = useNeedsYou(isFlipdesk || crossNeedsYou, ebayOn || crossNeedsYou);
  // Gated like every other FlipDesk read here: the grading view must not fire
  // the aggregate RPC and a 500-row conflicts read it never shows.
  const conflicts = useSyncConflicts(isFlipdesk);
  const queue = useExtensionQueue(isFlipdesk);
  const drafts = useAutolisterDrafts(isFlipdesk);
  const overview = useFlipdeskOverview(range, isFlipdesk);
  // On FlipDesk this is the cross-surface read: one grouped select.
  const crossGrading = isFlipdesk && hasGrading;
  const grading = useGradingAttentionCounts(isGrading || crossGrading);

  const chips = useMemo<AttentionChip[]>(() => {
    // The soonest deadline is the FIRST item's, because useNeedsYou returns the
    // list already ranked deadline-first. Re-sorting here would be a second
    // ranking rule to keep in step with the first.
    const soonest = needsYou.items[0]?.deadline ?? null;
    // The other half of the Overview. On FlipDesk, the grading statuses that
    // wait on the SELLER (pending_review waits on staff, so it is left out).
    const otherSide = isFlipdesk && crossGrading
      ? {
        count: (grading.data?.needsPhotos ?? 0) + (grading.data?.failed ?? 0) +
          (grading.data?.disputed ?? 0),
      }
      : crossNeedsYou
      ? { count: needsYou.items.length }
      : null;
    return buildAttentionChips({
      surface: isFlipdesk ? "flipdesk" : "grading",
      otherSide,
      flipdesk: isFlipdesk
        ? {
          needsYouCount: needsYou.items.length,
          needsYouDeadlineLabel: deadlineLabel(soonest),
          // A capped read: `rows` is at most `limit`, so on a very large
          // backlog this is a FLOOR. `truncated` says so and the chip reads
          // "500+" rather than presenting the floor as exact.
          draftsToReview: drafts.data?.rows.length ?? 0,
          draftsTruncated: drafts.data?.truncated ?? false,
          syncConflicts: conflicts.data?.total ?? 0,
          extensionJobsPending: queue.data?.pending.length ?? 0,
          extensionJobsFailed: queue.data?.needsAttention.length ?? 0,
          extensionJobsToReview: queue.data?.finishedNeedsReview.length ?? 0,
          agingCount: overview.data?.agingCount ?? 0,
          staleCount: overview.data?.staleCount ?? 0,
        }
        : null,
      grading: !isFlipdesk
        ? {
          needsPhotos: grading.data?.needsPhotos ?? 0,
          inReview: grading.data?.inReview ?? 0,
          failed: grading.data?.failed ?? 0,
          disputed: grading.data?.disputed ?? 0,
        }
        : null,
    });
  }, [
    isFlipdesk,
    crossGrading,
    crossNeedsYou,
    needsYou.items,
    drafts.data,
    conflicts.data,
    queue.data,
    overview.data,
    grading.data,
  ]);

  const sources = isFlipdesk
    ? crossGrading
      ? [conflicts, queue, drafts, overview, grading]
      : [conflicts, queue, drafts, overview]
    : [grading];
  const updatedAt = oldestUpdatedAt(sources.map((q) => q.dataUpdatedAt ?? 0));
  const now = useNow(30_000);
  const updatedLabel = relativeTime(updatedAt, now);
  const loading = sources.some((q) => q.isLoading) ||
    ((isFlipdesk || (isGrading && hasFlipdesk)) && ebay.isLoading) ||
    ((isFlipdesk || crossNeedsYou) && needsYou.isLoading);
  const refreshing = sources.some((q) => q.isFetching) ||
    ((isFlipdesk || crossNeedsYou) && needsYou.isFetching);

  // A source that failed is UNKNOWN, not zero. Its count above falls back to 0
  // so the other chips still render, and this list is what stops the rail
  // turning that 0 into "All clear". A plan-gated conflicts read (402/403) is
  // not applicable to the account, so it is not a failure.
  const failed: string[] = [];
  if (isFlipdesk) {
    if (conflicts.isError && !isPlanGateError(conflicts.error)) {
      failed.push("sync conflicts");
    }
    if (queue.isError) failed.push("extension jobs");
    if (drafts.isError) failed.push("drafts");
    if (overview.isError) failed.push("inventory");
    if (needsYou.isError || needsYou.isPartial) failed.push("eBay queues");
    if (crossGrading && grading.isError) failed.push("grading submissions");
  } else if (isGrading) {
    if (grading.isError) failed.push("submissions");
    if (crossNeedsYou && (needsYou.isError || needsYou.isPartial)) {
      failed.push("FlipDesk queues");
    }
  }
  const state = railState({
    chips,
    failed,
    loading,
    partial: (isFlipdesk || crossNeedsYou) && needsYou.isPartial,
  });

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
    for (const k of RAIL_QUERY_KEYS) prefixes.add(k);
    for (const p of prefixes) {
      void queryClient.invalidateQueries({ queryKey: [p] });
    }
    if (isFlipdesk || crossNeedsYou) needsYou.refetch();
    // The rail's own reads are not registry widgets, so a failed one is
    // retried directly; the "Could not check" chip's Retry depends on it.
    for (const q of sources) if (q.isError) void q.refetch();
  };

  if (!railSurface) return null;

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
      <div
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-3 gap-y-2"
      >
        {state === "loading"
          ? (
            <span className="text-sm text-muted-foreground">
              Checking what needs you…
            </span>
          )
          : state === "all-clear"
          ? <span className="text-sm font-medium">{ALL_CLEAR}</span>
          : (
            <>
              {chips.map((chip) => (
                <Link
                  key={chip.id}
                  to={chip.href}
                  className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-semibold tabular-nums">
                    {chip.countLabel ?? chip.count}
                  </span>
                  <span>{chip.label}</span>
                  {chip.hint
                    ? (
                      <span className="text-muted-foreground">
                        · {chip.hint}
                      </span>
                    )
                    : null}
                </Link>
              ))}
              {failed.length > 0
                ? (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 px-3 py-1 text-sm"
                    title={`Could not check: ${failed.join(", ")}`}
                  >
                    <span>
                      Could not check {failed.length}{" "}
                      {failed.length === 1 ? "source" : "sources"}
                    </span>
                    <button
                      type="button"
                      onClick={refreshAll}
                      className="font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                    >
                      Retry
                    </button>
                  </span>
                )
                : null}
            </>
          )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {updatedLabel
          ? (
            <span className="text-xs text-muted-foreground">
              Updated{" "}
              <time
                dateTime={new Date(updatedAt!).toISOString()}
                title={new Date(updatedAt!).toLocaleString()}
              >
                {updatedLabel}
              </time>
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
