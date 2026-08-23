import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuthStore } from "@/stores/auth-store";
import {
  categories,
  DIMENSION_LABEL,
  EMPTY_LIFT,
  strongestAssociation,
  UNCONTROLLED_WARNING,
  type ListingQualityLift,
} from "@/lib/listing-quality-lift";

// US-2826: listing_metrics, finally read against what the listing looked like.
//
// Every sentence here is an association. Sellers who take nine photos are not a
// random sample of sellers, so "8 or more photos sit alongside 3.1x the CTR" is
// true and "adding photos triples your CTR" is not, and the difference is the
// only thing standing between this panel and a bad decision.

const METRIC_LABEL = {
  medianCtr: "CTR",
  medianViews: "views",
  medianWatchers: "watchers",
} as const;

const ctr = (n: number | null): string =>
  n == null ? "—" : `${(n * 100).toFixed(2)}%`;
const num = (n: number | null): string =>
  n == null ? "—" : Math.round(n).toLocaleString();

export function ListingQualityLiftSection({
  periodStart,
}: {
  periodStart: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const [category, setCategory] = useState<string | null>(null);

  const { data = EMPTY_LIFT } = useQuery<ListingQualityLift>({
    queryKey: [
      "items_full",
      "analytics",
      "quality-lift",
      user?.id,
      periodStart,
    ],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { fetchListingQualityLift } = await import(
        "@/lib/listing-quality-lift"
      );
      return fetchListingQualityLift(periodStart);
    },
  });

  const cats = useMemo(() => categories(data), [data]);
  const finding = useMemo(() => strongestAssociation(data), [data]);
  const active = category ?? cats[0] ?? null;
  const rows = useMemo(
    () => data.byCategory.filter((b) => b.category === active),
    [data, active],
  );

  if (data.listingsIncluded === 0) {
    if (data.listingsExcluded === 0) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Eye className="h-4 w-4" />
            What listing work is worth
          </CardTitle>
          <CardDescription>
            None of your {data.listingsExcluded} listings has {data.minDays}{" "}
            days of traffic history yet. The eBay sync writes one row per listing
            per day, so this fills in as they age.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Eye className="h-4 w-4" />
              What listing work is worth
            </CardTitle>
            <CardDescription>
              First {data.windowDays} days of traffic, grouped by how the listing
              was built. Compared inside one category, because outerwear outdraws
              tees at any photo count.
            </CardDescription>
          </div>
          {cats.length > 1 && (
            <Select
              value={active ?? ""}
              onValueChange={(v) => setCategory(v)}
            >
              <SelectTrigger
                className="w-48"
                aria-label="Category for the listing comparison"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {cats.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        {finding && (
          <p className="px-6 text-sm">
            In {finding.category}, listings with{" "}
            {DIMENSION_LABEL[finding.dimension].toLowerCase()}{" "}
            <span className="font-medium">{finding.bestBucket}</span> sit
            alongside{" "}
            <span className="font-medium">{finding.ratio.toFixed(1)}x</span> the{" "}
            {METRIC_LABEL[finding.metric]} of{" "}
            <span className="font-medium">{finding.worstBucket}</span>. That is
            an association across {finding.listings} listings, not proof that
            one causes the other.
          </p>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Grouped by</TableHead>
              <TableHead>Bucket</TableHead>
              <TableHead className="text-right">Listings</TableHead>
              <TableHead className="text-right">Impressions</TableHead>
              <TableHead className="text-right">Views</TableHead>
              <TableHead className="text-right">Watchers</TableHead>
              <TableHead className="pr-6 text-right">CTR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((b, i) => (
              <TableRow key={`${b.dimension}-${b.bucket}`}>
                <TableCell className="pl-6 font-medium">
                  {i === 0 || rows[i - 1]!.dimension !== b.dimension
                    ? DIMENSION_LABEL[b.dimension]
                    : ""}
                </TableCell>
                <TableCell>{b.bucket}</TableCell>
                <TableCell className="text-right">{b.listings}</TableCell>
                <TableCell className="text-right">
                  {num(b.medianImpressions)}
                </TableCell>
                <TableCell className="text-right">
                  {num(b.medianViews)}
                </TableCell>
                <TableCell className="text-right">
                  {b.medianWatchers == null ? "—" : b.medianWatchers.toFixed(1)}
                </TableCell>
                <TableCell className="pr-6 text-right">
                  {ctr(b.medianCtr)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <p className="px-6 text-xs text-muted-foreground">
          {data.listingsIncluded} listings included, {data.listingsExcluded}{" "}
          excluded for having under {data.minDays} days of history. A pooled
          all-category view is in the export. {UNCONTROLLED_WARNING}
        </p>
      </CardContent>
    </Card>
  );
}
