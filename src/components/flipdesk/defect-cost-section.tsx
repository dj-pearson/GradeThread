import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ScanSearch } from "lucide-react";
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
  costPercent,
  defectImpact,
  defectLabel,
  EMPTY_DEFECT_COST,
  quotableRows,
  topCostForSeller,
  type DefectCostReport,
} from "@/lib/defect-cost";

// US-2821: the Defect Cost Ledger, on the Grading ROI tab.
//
// The lead line names the most expensive flaw the seller ACTUALLY HAS, which is
// the only version of this that changes what anyone does. A ledger topped by a
// defect they have never had is market trivia.
//
// Every figure is a share of the item's own grade band, so the number is about
// the flaw rather than about the grade the flaw already lowered. The table says
// so in its description rather than leaving a reader to infer it.

const csvDate = (): string => new Date().toISOString().slice(0, 10);

const pct = (n: number | null): string =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "" : "+"}${Math.abs(n).toFixed(1)}%`;

export function DefectCostSection({
  periodStart,
}: {
  periodStart: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const { data = EMPTY_DEFECT_COST } = useQuery<DefectCostReport>({
    queryKey: ["items_full", "analytics", "defect-cost", user?.id, periodStart],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { fetchDefectCost } = await import("@/lib/defect-cost");
      return fetchDefectCost(periodStart);
    },
  });

  const rows = useMemo(() => quotableRows(data), [data]);
  const top = useMemo(() => topCostForSeller(data), [data]);

  if (rows.length === 0) {
    if (data.itemsScored === 0) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScanSearch className="h-4 w-4" />
            Defect cost
          </CardTitle>
          <CardDescription>
            {data.itemsWithDefects} sold{" "}
            {data.itemsWithDefects === 1 ? "item has" : "items have"} recorded
            defects, but no flaw yet has the {data.minDefectSample} sales it
            needs before a cost is quoted.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  function exportCsv() {
    downloadCsv(
      `flipdesk-defect-cost-${csvDate()}.csv`,
      [
        "Defect",
        "Severity",
        "Your items",
        "Your price ratio",
        "Your days vs band",
        "Cohort items",
        "Cohort sellers",
        "Cohort price ratio",
        "Cohort days vs band",
        "Cost %",
      ],
      rows.map((r) => [
        r.defect,
        r.severity,
        r.ownCount,
        r.ownPriceRatio ?? "",
        r.ownDaysDelta ?? "",
        r.cohortCount,
        r.cohortSellers,
        r.cohortPriceRatio ?? "",
        r.cohortDaysDelta ?? "",
        costPercent(r)?.toFixed(1) ?? "",
      ]),
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScanSearch className="h-4 w-4" />
              Defect cost
            </CardTitle>
            <CardDescription>
              Every figure compares an item to others the grader scored the
              same, so it measures the flaw and not the grade the flaw already
              lowered.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        {top && (
          <p className="px-6 text-sm">
            <span className="font-medium">
              {defectLabel(top.defect)} ({top.severity})
            </span>{" "}
            is costing you the most: items with it clear{" "}
            <span className="font-medium">
              {(costPercent(top) ?? 0).toFixed(0)}% less
            </span>{" "}
            than others at the same grade
            {defectImpact(top).daysDelta != null &&
              `, and sit ${Math.round(defectImpact(top).daysDelta!)} days longer`}
            .
          </p>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Defect</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead className="text-right">Costs</TableHead>
              <TableHead className="text-right">Days vs band</TableHead>
              <TableHead className="text-right">Your items</TableHead>
              <TableHead className="pr-6 text-right">Based on</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const impact = defectImpact(r);
              return (
                <TableRow key={`${r.defect}|${r.severity}`}>
                  <TableCell className="pl-6 font-medium">
                    {defectLabel(r.defect)}
                  </TableCell>
                  <TableCell>{r.severity}</TableCell>
                  <TableCell className="text-right font-medium">
                    {pct(costPercent(r))}
                  </TableCell>
                  <TableCell className="text-right">
                    {impact.daysDelta == null
                      ? "—"
                      : `${impact.daysDelta > 0 ? "+" : ""}${Math.round(impact.daysDelta)}d`}
                  </TableCell>
                  <TableCell className="text-right">{r.ownCount}</TableCell>
                  <TableCell className="pr-6 text-right text-muted-foreground">
                    {impact.count}{" "}
                    {impact.source === "cohort" ? "cohort" : "own"}
                    {impact.source === "own" && (
                      <Badge variant="outline" className="ml-2">
                        own data
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        <p className="px-6 text-xs text-muted-foreground">
          A positive cost means the flaw sells for less than its grade implies; a
          negative one means those items beat their grade, which usually means
          you are disclosing it well. {data.noDefectsRecorded} sold{" "}
          {data.noDefectsRecorded === 1 ? "item" : "items"} recorded no defects,
          which mixes genuinely clean grades with grades produced before the
          defect list was stored, so it is not used as a baseline.
        </p>
      </CardContent>
    </Card>
  );
}
