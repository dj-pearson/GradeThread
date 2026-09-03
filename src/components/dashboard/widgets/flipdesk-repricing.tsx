import { TrendingDown } from "lucide-react";
import { useRepricingSuggestions } from "@/hooks/use-repricing";
import {
  StatTile,
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-3077 AC9: price nudges waiting on a decision.
//
// reason_code "OK" is excluded, and that is the whole point of the widget
// rather than a detail of it. The scan writes a row for every listing it
// looked at, most of them saying "this price is fine"; counting those would
// show a seller with nothing to do a number in the hundreds, which teaches
// them to ignore the tile. What is left is genuinely actionable:
// UNDERPRICED, OVERPRICED, STALE, NO_COMPS.

export function FlipdeskRepricingWidget() {
  const { data, isLoading, isError, isFetching, refetch } =
    useRepricingSuggestions();

  if (isLoading) return <StatTileSkeleton label="repricing nudges" />;
  if (isError) {
    return (
      <WidgetLoadError
        what="your repricing nudges"
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  const open = (data ?? []).filter((s) => s.reason_code !== "OK");
  const underpriced = open.filter((s) => s.reason_code === "UNDERPRICED").length;

  return (
    <StatTile
      label="Repricing nudges"
      icon={<TrendingDown className="h-5 w-5" />}
      value={open.length.toLocaleString()}
      sub={
        open.length === 0
          ? "Every price is where the comps put it"
          : underpriced > 0
            ? `${underpriced} priced under the comps`
            : "Waiting on your call"
      }
      to="/dashboard/flipdesk/pricing?tab=repricing"
    />
  );
}
