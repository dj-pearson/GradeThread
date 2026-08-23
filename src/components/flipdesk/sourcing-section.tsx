import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, MapPin, Timer } from "lucide-react";
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
import { useItemsList } from "@/hooks/use-items-full";
import {
  EMPTY_SOURCE_YIELD,
  sourceFinding,
  type SourceYieldReport,
} from "@/lib/source-yield";
import {
  capitalVelocity,
  deadestCapital,
  rankedGroups,
  type VelocityGroupKey,
} from "@/lib/capital-velocity";

// US-2824 + US-2825: the two "what should I buy more of" reports, on the
// Sell-through tab.
//
// They answer opposite halves of the same question. Source yield is about the
// buy: what condition a venue hands you and what a grade point costs there.
// Capital velocity is about the hold: what a dollar earned per day it was tied
// up. A venue can be cheap and still be the worst thing you do with money.

const csvDate = (): string => new Date().toISOString().slice(0, 10);
const usd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;
const pct = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `${Math.round(n * 100)}%`;

export function SourceYieldCard({
  periodStart,
}: {
  periodStart: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const { data = EMPTY_SOURCE_YIELD } = useQuery<SourceYieldReport>({
    queryKey: ["items_full", "analytics", "source-yield", user?.id, periodStart],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { fetchSourceYield } = await import("@/lib/source-yield");
      return fetchSourceYield(periodStart);
    },
  });

  const finding = useMemo(() => sourceFinding(data), [data]);

  if (data.rows.length === 0) {
    if (data.itemsWithoutPurchaseDate === 0) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="h-4 w-4" />
            Source yield
          </CardTitle>
          <CardDescription>
            Nothing to compare: {data.itemsWithoutPurchaseDate} items have no
            purchase date, and this report windows on when you bought, not when
            you sold. Stamp a purchase date at intake and this fills in.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  function exportCsv() {
    downloadCsv(
      `flipdesk-source-yield-${csvDate()}.csv`,
      [
        "Source",
        "Items sourced",
        "Graded share",
        "Avg purchase price",
        "Median grade",
        "Cost per grade point",
        "Sell-through",
        "Median net profit",
        "Median days to sell",
      ],
      data.rows.map((r) => [
        r.source,
        r.itemsSourced,
        r.gradedShare ?? "",
        r.avgPurchasePrice ?? "",
        r.medianGrade ?? "",
        r.costPerGradePoint ?? "",
        r.sellThrough ?? "",
        r.medianNetProfit ?? "",
        r.medianDaysToSell ?? "",
      ]),
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <MapPin className="h-4 w-4" />
              Source yield
            </CardTitle>
            <CardDescription>
              What each venue hands you, and what a point of grade costs there.
              Windowed on when you bought, not when you sold.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        {finding && (
          <p className="px-6 text-sm">
            A grade point costs{" "}
            <span className="font-medium">{finding.ratio.toFixed(1)}x</span> more
            at <span className="font-medium">{finding.worst.source}</span> (
            {usd(finding.worst.costPerGradePoint)}) than at{" "}
            <span className="font-medium">{finding.best.source}</span> (
            {usd(finding.best.costPerGradePoint)}).
          </p>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Source</TableHead>
              <TableHead className="text-right">Sourced</TableHead>
              <TableHead className="text-right">Graded</TableHead>
              <TableHead className="text-right">Avg cost</TableHead>
              <TableHead className="text-right">Median grade</TableHead>
              <TableHead className="text-right">Per grade point</TableHead>
              <TableHead className="text-right">Sell-through</TableHead>
              <TableHead className="pr-6 text-right">Median profit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={r.source}>
                <TableCell className="pl-6 font-medium">
                  {r.source}
                  {r.thin && (
                    <Badge variant="outline" className="ml-2">
                      under {data.minSample}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">{r.itemsSourced}</TableCell>
                <TableCell className="text-right">
                  {pct(r.gradedShare)}
                </TableCell>
                <TableCell className="text-right">
                  {usd(r.avgPurchasePrice)}
                </TableCell>
                <TableCell className="text-right">
                  {r.medianGrade == null ? "—" : r.medianGrade.toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {usd(r.costPerGradePoint)}
                </TableCell>
                <TableCell className="text-right">
                  {pct(r.sellThrough)}
                </TableCell>
                <TableCell className="pr-6 text-right">
                  {usd(r.medianNetProfit)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {data.itemsWithoutPrice > 0 && (
          <p className="px-6 text-xs text-muted-foreground">
            {data.itemsWithoutPrice} sourced{" "}
            {data.itemsWithoutPrice === 1 ? "item has" : "items have"} no
            purchase price and are left out of every cost figure. A free item is
            real; dividing by its zero cost is not.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function CapitalVelocityCard({
  groupKey,
}: {
  groupKey: VelocityGroupKey;
}) {
  const { data: items = [] } = useItemsList();

  // Aged against today, passed in rather than read inside the pure module so
  // the module stays deterministic in a test.
  const asOf = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const report = useMemo(
    () => capitalVelocity(items, groupKey, asOf),
    [items, groupKey, asOf],
  );
  const ranked = useMemo(() => rankedGroups(report), [report]);
  const dead = useMemo(() => deadestCapital(report), [report]);

  if (ranked.length === 0 && !dead) return null;

  const best = ranked[0];
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer className="h-4 w-4" />
          Capital velocity
        </CardTitle>
        <CardDescription>
          What a dollar earned for each day it was tied up. Profit alone rewards
          expensive stock; this rewards stock that turns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <div className="space-y-1 px-6 text-sm">
          {best && (
            <p>
              <span className="font-medium">{best.group}</span> returns{" "}
              <span className="font-medium">
                {best.velocityPctPerDay!.toFixed(2)}%
              </span>{" "}
              per dollar per day, over {best.soldItems} sales.
            </p>
          )}
          {worst && (
            <p className="text-muted-foreground">
              {worst.group} returns {worst.velocityPctPerDay!.toFixed(2)}% on the
              same measure.
            </p>
          )}
          {dead && (
            <p>
              <span className="font-medium">{usd(dead.parkedCapital)}</span> is
              parked in {dead.group} across {dead.parkedItems}{" "}
              {dead.parkedItems === 1 ? "item" : "items"} that have never sold
              {dead.medianDaysParked != null &&
                `, median ${Math.round(dead.medianDaysParked)} days held`}
              .
            </p>
          )}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Group</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Capital out</TableHead>
              <TableHead className="text-right">Profit</TableHead>
              <TableHead className="text-right">Median days</TableHead>
              <TableHead className="text-right">Per $ per day</TableHead>
              <TableHead className="pr-6 text-right">Parked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.rows.map((r) => (
              <TableRow key={r.group}>
                <TableCell className="pl-6 font-medium">{r.group}</TableCell>
                <TableCell className="text-right">{r.soldItems}</TableCell>
                <TableCell className="text-right">
                  {usd(r.deployedCapital)}
                </TableCell>
                <TableCell className="text-right">
                  {usd(r.realizedProfit)}
                </TableCell>
                <TableCell className="text-right">
                  {r.medianDaysHeld == null
                    ? "—"
                    : `${Math.round(r.medianDaysHeld)}d`}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {r.velocityPctPerDay == null
                    ? "—"
                    : `${r.velocityPctPerDay.toFixed(2)}%`}
                </TableCell>
                <TableCell className="pr-6 text-right">
                  {r.parkedCapital > 0 ? usd(r.parkedCapital) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {report.unpricedItems > 0 && (
          <p className="px-6 text-xs text-muted-foreground">
            {report.unpricedItems}{" "}
            {report.unpricedItems === 1 ? "item has" : "items have"} no purchase
            price and hold no measurable capital, so they are outside every
            figure here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
