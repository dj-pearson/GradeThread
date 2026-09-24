import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { fetchInChunks } from "@/lib/supabase-batch";
import { ListingSuggestions } from "@/components/analytics/listing-suggestions";
import { Skeleton } from "@/components/ui/skeleton";
import { WidgetLoadError } from "@/components/dashboard/widgets/flipdesk-shared";
import type {
  GradeReportRow,
  InventoryItemRow,
  ListingRow,
} from "@/types/database";

// US-3075 AC1: the listing-suggestions block, as a widget.
//
// US-411: the suggestions only act on ACTIVE inventory (they skip
// sold/shipped/completed/returned) and read a handful of columns. The status
// filter and a candidate cap are pushed to the server and only the rendered
// columns are selected, so this stays fast regardless of total inventory size.
//
// US-1636: query failures are surfaced rather than swallowed into a wrong
// zero-state. Here that means throwing, which the board's own error boundary
// turns into a frame that says so.

const SUGGESTION_CANDIDATE_CAP = 200;

interface SuggestionData {
  items: InventoryItemRow[];
  listings: ListingRow[];
  gradeReports: GradeReportRow[];
}

export function GradingListingSuggestionsWidget() {
  const { data, isLoading, isError, isFetching, refetch } = useQuery<SuggestionData>({
    queryKey: ["dashboard-listing-suggestions"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // RLS scopes every table below to the signed-in account.
      const { data: itemsRaw, error: itemsError } = await supabase
        .from("inventory_items")
        .select("id, status, title, submission_id")
        // Archived items are out of stock by choice; suggesting a listing for
        // one is noise.
        .not("status", "in", "(sold,shipped,completed,returned,archived)")
        // Oldest first: the item that has waited longest is the one a
        // suggestion helps most, and a newest-first cap cut it off.
        .order("created_at", { ascending: true })
        .limit(SUGGESTION_CANDIDATE_CAP);
      if (itemsError) throw itemsError;
      const items = (itemsRaw ?? []) as unknown as InventoryItemRow[];

      const itemIds = items.map((i) => i.id);
      const listings = await fetchInChunks<ListingRow>(itemIds, async (chunk) => {
        const { data: rows, error } = await supabase
          .from("listings")
          .select("inventory_item_id, is_active, listed_at, platform")
          .in("inventory_item_id", chunk);
        return { data: rows as unknown as ListingRow[] | null, error };
      });

      const submissionIds = items
        .map((i) => i.submission_id)
        .filter((id): id is string => id !== null);
      const gradeReports = await fetchInChunks<GradeReportRow>(
        submissionIds,
        async (chunk) => {
          const { data: rows, error } = await supabase
            .from("grade_reports")
            .select("submission_id, confidence_score")
            .in("submission_id", chunk)
            .is("superseded_at", null); // US-479: active report per submission
          return { data: rows as unknown as GradeReportRow[] | null, error };
        },
      );

      return { items, listings, gradeReports };
    },
  });

  if (isLoading) return <Skeleton className="h-32 w-full rounded-xl" />;
  if (isError) {
    return (
      <WidgetLoadError
        what="your listing suggestions"
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }
  if (!data) return null;

  return (
    <ListingSuggestions
      items={data.items}
      listings={data.listings}
      gradeReports={data.gradeReports}
      maxItems={5}
    />
  );
}
