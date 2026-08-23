import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleDollarSign, Download, Pencil, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { downloadCsv } from "@/lib/csv-export";
import { useAuthStore } from "@/stores/auth-store";
import {
  basisLabel,
  fetchPriceGap,
  gapHeadline,
  isCohortBasis,
  worstFirst,
  EMPTY_PRICE_GAP,
  type PriceGapReport,
} from "@/lib/price-gap";

// US-2820: Money Left On The Table.
//
// Two surfaces over one query. The card fronts the Sell-through tab with the
// single dollar figure and sends the seller to the detail; the detail lives
// beside the curve that produced it, because a number nobody can trace is a
// number nobody acts on.
//
// The query key sits under the same "items_full" prefix as every other FlipDesk
// aggregate, so a pipeline mutation invalidates this too.

const usd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;

const CURVE_TAB = "/dashboard/flipdesk/analytics/price-curve";

function usePriceGap(periodStart: string | null) {
  const user = useAuthStore((s) => s.user);
  return useQuery<PriceGapReport>({
    queryKey: ["items_full", "analytics", "price-gap", user?.id, periodStart],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchPriceGap(periodStart),
  });
}

/** The headline card. Renders nothing at all when the report cannot honestly
 *  produce a figure — an empty card teaching a seller to ignore the slot is
 *  worse than no slot. */
export function PriceGapCard({ periodStart }: { periodStart: string | null }) {
  const { data = EMPTY_PRICE_GAP } = usePriceGap(periodStart);
  const headline = useMemo(() => gapHeadline(data), [data]);

  if (!headline) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleDollarSign className="h-4 w-4" />
          Money left on the table
        </CardTitle>
        <CardDescription>
          Your sold items against what your condition price curve says that
          grade clears.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-3xl font-bold">{usd(headline.totalGapDollars)}</p>
        <p className="text-sm text-muted-foreground">
          Across {headline.itemsScored}{" "}
          {headline.itemsScored === 1 ? "sale" : "sales"} that could be priced (
          {Math.round(headline.coverage * 100)}% of the period). An estimate
          against{" "}
          {headline.anyCohort
            ? "seller cohort medians"
            : "your own realized sales"}
          , not a recoverable amount.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={CURVE_TAB}>
              See the items
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          {data.liveScored > 0 && (
            <Badge variant="outline">
              {data.liveScored} live{" "}
              {data.liveScored === 1 ? "listing" : "listings"} under the curve
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The traceable half: which items, by how much, and on what evidence. */
export function PriceGapDetail({ periodStart }: { periodStart: string | null }) {
  const { data = EMPTY_PRICE_GAP } = usePriceGap(periodStart);
  const worst = useMemo(() => worstFirst(data.worst), [data.worst]);

  // US-2829: TWO exports, not one, and that is AC6 rather than laziness.
  //
  // The two tables answer different questions and label the same column
  // differently: a live listing is "Asking / Under by", a sold one is
  // "Sold for / Short by". AC6 requires the CSV headers to match the on-screen
  // labels exactly so a seller can map them without a guide, and one merged
  // file would have to invent neutral wording for both — which is precisely the
  // decoder the criterion exists to avoid.
  //
  // The seller-facing difference is real too: the live list is work they can
  // still do, and the sold list is a receipt. Merging them buries the first.
  const csvDate = () => new Date().toISOString().slice(0, 10);

  function exportLiveCsv() {
    downloadCsv(
      `flipdesk-underpriced-live-${csvDate()}.csv`,
      ["Item", "Brand", "Basis", "Grade", "Asking", "Curve", "Under by"],
      data.live.map((r) => [
        r.title,
        r.brand,
        basisLabel(r.basis),
        r.grade.toFixed(1),
        r.listPrice,
        r.curveMedian ?? "",
        r.gapDollars ?? "",
      ]),
    );
  }

  function exportSoldCsv() {
    downloadCsv(
      `flipdesk-shortfalls-sold-${csvDate()}.csv`,
      ["Item", "Brand", "Basis", "Grade", "Sold for", "Curve", "Short by"],
      worst.map((r) => [
        r.title,
        r.brand,
        basisLabel(r.basis),
        r.grade.toFixed(1),
        r.salePrice ?? "",
        r.curveMedian ?? "",
        r.gapDollars ?? "",
      ]),
    );
  }

  if (worst.length === 0 && data.live.length === 0) return null;

  return (
    <div className="space-y-4">
      {data.live.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Tag className="h-4 w-4" />
                  Live listings priced under their grade
                </CardTitle>
                <CardDescription>
                  Still for sale, and asking less than the curve for that grade.
                  These are the ones you can still change.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={exportLiveCsv}
                aria-label="Export the underpriced live listings as CSV"
              >
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Item</TableHead>
                  <TableHead className="text-right">Grade</TableHead>
                  <TableHead className="text-right">Asking</TableHead>
                  <TableHead className="text-right">Curve</TableHead>
                  <TableHead className="text-right">Under by</TableHead>
                  <TableHead className="pr-6" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.live.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="pl-6">
                      <span className="font-medium">{r.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {r.brand} · from {basisLabel(r.basis)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.grade.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right">
                      {usd(r.listPrice)}
                    </TableCell>
                    <TableCell className="text-right">
                      {usd(r.curveMedian)}
                      {!isCohortBasis(r.basis) && (
                        <Badge variant="outline" className="ml-2">
                          own data
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {usd(r.gapDollars)}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/dashboard/flipdesk/items/${r.id}/draft`}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {worst.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  Biggest shortfalls, already sold
                </CardTitle>
                <CardDescription>
                  Nothing to do about these. They are here so the total above has
                  a list behind it.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={exportSoldCsv}
                aria-label="Export the biggest sold shortfalls as CSV"
              >
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Item</TableHead>
                  <TableHead className="text-right">Grade</TableHead>
                  <TableHead className="text-right">Sold for</TableHead>
                  <TableHead className="text-right">Curve</TableHead>
                  <TableHead className="pr-6 text-right">Short by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {worst.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="pl-6">
                      <span className="font-medium">{r.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {r.brand} · from {basisLabel(r.basis)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.grade.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right">
                      {usd(r.salePrice)}
                    </TableCell>
                    <TableCell className="text-right">
                      {usd(r.curveMedian)}
                    </TableCell>
                    <TableCell className="pr-6 text-right font-medium">
                      {usd(r.gapDollars)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {data.itemsUnscored > 0 && (
        <p className="text-sm text-muted-foreground">
          {data.itemsUnscored} sold{" "}
          {data.itemsUnscored === 1 ? "item" : "items"} could not be priced:
          fewer than {data.minSample} comparable sales at that grade, or fewer
          than {data.minSellers} sellers behind them.
        </p>
      )}
    </div>
  );
}
