import { Link } from "react-router";
import { Stamp } from "lucide-react";
import { usePassportSummary } from "@/hooks/use-passport-summary";
import { Skeleton } from "@/components/ui/skeleton";

// US-3075 AC1: the seller's own Garment Passports, as a widget.
//
// The count fed one Discover card before the board existed and was never shown
// on its own. It is the developer persona's proof that an integration produced
// something public, which is why their default board carries it.

export function GradingPassportsWidget() {
  const { data, isLoading, isError } = usePassportSummary();

  if (isLoading) return <Skeleton className="h-24 w-full rounded-xl" />;

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-6" role="alert">
        <p className="text-sm text-muted-foreground">
          Could not count your passports just now.
        </p>
      </div>
    );
  }

  const to = data.latestSlug
    ? `/passport/${data.latestSlug}`
    : "/dashboard/submissions/new";

  return (
    <Link
      to={to}
      className="block rounded-xl border px-4 py-4 transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Garment passports</span>
        <Stamp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </span>
      <span className="block text-2xl font-bold tabular-nums">{data.count}</span>
      <span className="mt-0.5 block text-xs text-muted-foreground">
        {data.count === 0
          ? "Grade an item to create your first"
          : data.latestSlug
            ? "View the latest provenance timeline"
            : "Created from your grades"}
      </span>
    </Link>
  );
}
