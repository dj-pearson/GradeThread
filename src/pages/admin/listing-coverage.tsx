import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Gauge, AlertTriangle } from "lucide-react";

// US-2425: how complete are AutoLister's generated drafts?
//
// Reads /api/admin/listing-coverage (edge, admin-gated, cross-tenant). Every
// change to the specifics pipeline — a wider capture (US-2421), aspects the
// registry can reach (US-2422), projection onto the draft (US-2423), a better
// category pick (US-2424) — either moves these medians or it did not help.
//
// Required and recommended stay in SEPARATE columns on purpose: a required gap
// blocks the publish outright, a recommended gap only costs search placement.
// A single blended score would hide the one that stops a seller shipping.

const WINDOWS = ["50", "200", "500", "1000"] as const;

interface CategorySummary {
  categoryId: string;
  drafts: number;
  medianRecommended: number | null;
  medianRequired: number | null;
  draftsBlocked: number;
  topMissing: Array<{ name: string; drafts: number }>;
}

interface CoverageReport {
  window: number;
  drafts: number;
  medianRecommended: number | null;
  medianRequired: number | null;
  draftsBlocked: number;
  byCategory: CategorySummary[];
}

/** A 0..1 share as a percentage, or an em-less "n/a" when the tier had no
 *  aspects to measure — an unmeasurable leaf is not a zero-coverage leaf. */
function pct(share: number | null): string {
  return share === null ? "n/a" : `${Math.round(share * 100)}%`;
}

// Thresholds are deliberately blunt: this is a "where do I look next" page, not
// an SLA. Anything under half the recommended aspects is worth investigating.
function coverageTone(share: number | null): string {
  if (share === null) return "text-muted-foreground";
  if (share >= 0.75) return "text-emerald-700 dark:text-emerald-400";
  if (share >= 0.5) return "text-amber-700 dark:text-amber-400";
  return "text-destructive";
}

export function AdminListingCoveragePage() {
  const [windowSize, setWindowSize] = useState<string>("200");
  const windowSelectId = useId();

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-listing-coverage", windowSize],
    queryFn: async (): Promise<CoverageReport> => {
      const res = await edgeFetch(
        `/api/admin/listing-coverage?limit=${encodeURIComponent(windowSize)}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load draft coverage.");
      return json as CoverageReport;
    },
    staleTime: 60 * 1000,
  });

  const blockedShare = useMemo(() => {
    if (!data || data.drafts === 0) return null;
    return data.draftsBlocked / data.drafts;
  }, [data]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Gauge}
        title="Draft specifics coverage"
        subtitle="Median eBay item-specific coverage of recently generated AutoLister drafts, by leaf category."
      />

      <div className="flex items-center gap-3">
        <Label htmlFor={windowSelectId} className="text-sm text-muted-foreground">
          Most recent
        </Label>
        <Select value={windowSize} onValueChange={setWindowSize}>
          <SelectTrigger id={windowSelectId} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((w) => (
              <SelectItem key={w} value={w}>
                {w} drafts
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-6 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            {(error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryTile label="Drafts scored" value={String(data.drafts)} />
            <SummaryTile
              label="Median required filled"
              value={pct(data.medianRequired)}
              tone={coverageTone(data.medianRequired)}
            />
            <SummaryTile
              label="Median recommended filled"
              value={pct(data.medianRecommended)}
              tone={coverageTone(data.medianRecommended)}
            />
            <SummaryTile
              label="Blocked by a required gap"
              value={
                blockedShare === null
                  ? "n/a"
                  : `${data.draftsBlocked} (${Math.round(blockedShare * 100)}%)`
              }
              tone={data.draftsBlocked > 0 ? "text-destructive" : undefined}
            />
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>eBay leaf</TableHead>
                      <TableHead className="text-right">Drafts</TableHead>
                      <TableHead className="text-right">Required</TableHead>
                      <TableHead className="text-right">Recommended</TableHead>
                      <TableHead className="text-right">Blocked</TableHead>
                      <TableHead>Most-missed specifics</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byCategory.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                          No leaf category has enough scored drafts yet. Coverage is
                          recorded from the next AutoLister run onward.
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.byCategory.map((row) => (
                        <TableRow key={row.categoryId}>
                          <TableCell className="font-medium">{row.categoryId}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.drafts}</TableCell>
                          <TableCell className={`text-right tabular-nums ${coverageTone(row.medianRequired)}`}>
                            {pct(row.medianRequired)}
                          </TableCell>
                          <TableCell className={`text-right tabular-nums ${coverageTone(row.medianRecommended)}`}>
                            {pct(row.medianRecommended)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.draftsBlocked}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {row.topMissing.map((m) => (
                                <Badge key={m.name} variant="secondary">
                                  {m.name} · {m.drafts}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 py-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold tabular-nums ${tone ?? ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
