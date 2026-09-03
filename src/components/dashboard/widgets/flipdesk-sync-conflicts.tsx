import { GitCompareArrows } from "lucide-react";
import { useSyncConflicts } from "@/hooks/use-sync-conflicts";
import {
  StatTile,
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-3077 AC4 (registry AC5): unresolved FlipDesk / eBay / Sheets disagreements.
//
// A conflict is a price or a status that two systems each believe. Every hour
// it sits there is an hour one of the two is wrong somewhere a buyer can see,
// so this counts and links, and does not try to summarise which side is right.
// That judgement is the resolver's job.
//
// `total` rather than `conflicts.length`: the endpoint pages, and a widget that
// said 25 because the first page held 25 would go quiet at exactly the point a
// seller most needed the real number.

/**
 * Where the resolver lives.
 *
 * AC5 calls it "the inventory surface"; it is a tab of Reconcile, which moved
 * under Money (src/routes/index.tsx). This is the deep link the rest of the app
 * already uses, so following the AC's wording literally would have pointed at
 * a redirect at best and a 404 at worst.
 */
const RESOLVER = "/dashboard/flipdesk/money?view=reconcile&tab=cross-source";

export function FlipdeskSyncConflictsWidget() {
  const { data, isLoading, isError, isFetching, refetch } = useSyncConflicts();

  if (isLoading) return <StatTileSkeleton label="sync conflicts" />;
  if (isError) {
    return (
      <WidgetLoadError
        what="your sync conflicts"
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  const total = data?.total ?? 0;

  return (
    <StatTile
      label="Sync conflicts"
      icon={<GitCompareArrows className="h-5 w-5" />}
      value={total.toLocaleString()}
      sub={
        total === 0
          ? "Your channels agree"
          : "Pick which source wins on each one"
      }
      to={RESOLVER}
    />
  );
}
