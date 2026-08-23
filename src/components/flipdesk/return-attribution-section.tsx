import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crosshair, Download } from "lucide-react";
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
  EMPTY_ATTRIBUTION,
  FACTOR_LABEL,
  hasNoFindings,
  worstFactor,
  worstUndisclosedDefect,
  type ReturnAttribution,
} from "@/lib/return-attribution";
import { defectLabel } from "@/lib/defect-cost";

// US-2823: "What actually predicts your returns", under the grade bands.
//
// The grade bands above answer "do worse items come back more". They do. This
// answers the question that follows, which is the one a seller can act on:
// WHICH part of the condition, and does saying so in the listing help.

const rate = (n: number | null): string =>
  n == null ? "—" : `${(n * 100).toFixed(1)}%`;

export function ReturnAttributionSection({
  periodStart,
}: {
  periodStart: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const { data = EMPTY_ATTRIBUTION } = useQuery<ReturnAttribution>({
    queryKey: [
      "items_full",
      "analytics",
      "return-attribution",
      user?.id,
      periodStart,
    ],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { fetchReturnAttribution } = await import("@/lib/return-attribution");
      return fetchReturnAttribution(periodStart);
    },
  });

  const factor = useMemo(() => worstFactor(data), [data]);
  const defect = useMemo(() => worstUndisclosedDefect(data), [data]);
  const nothing = useMemo(() => hasNoFindings(data), [data]);

  if (data.overall.fulfilled === 0) return null;

  // US-2829 AC6: one export per TABLE, headers matching that table's own
  // on-screen labels. The two answer different questions — which grade factor
  // predicts a return, and whether SAYING SO changed anything — and their
  // columns share no wording, so a merged file would need invented headers.
  //
  // A null rate is left EMPTY rather than written as 0. The screen shows a dash
  // because the band is under MIN_ATTRIBUTION_SAMPLE, and a zero in a
  // spreadsheet reads as 'no returns' — the opposite of 'not enough sales to
  // say'. The sold counts travel beside each rate so the blank has a reason.
  const csvDate = () => new Date().toISOString().slice(0, 10);

  function exportFactorsCsv() {
    downloadCsv(
      `flipdesk-return-attribution-${csvDate()}.csv`,
      ["Factor", "Band", "Fulfilled", "Returns", "Rate"],
      data.factors.flatMap((f) =>
        f.bands.map((b) => [
          FACTOR_LABEL[f.factor],
          b.label,
          b.fulfilled,
          b.returns,
          b.rate ?? "",
        ]),
      ),
    );
  }

  function exportDisclosureCsv() {
    downloadCsv(
      `flipdesk-defect-disclosure-${csvDate()}.csv`,
      [
        "Defect",
        "Severity",
        "Disclosed",
        "Disclosed sold",
        "Not disclosed",
        "Not disclosed sold",
        "Difference",
      ],
      data.defects.map((d) => [
        defectLabel(d.defect),
        d.severity,
        d.disclosedRate ?? "",
        d.disclosedCount,
        d.undisclosedRate ?? "",
        d.undisclosedCount,
        d.disclosedRate != null && d.undisclosedRate != null && d.disclosedRate > 0
          ? (d.undisclosedRate / d.disclosedRate).toFixed(1)
          : "",
      ]),
    );
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
        <CardTitle className="flex items-center gap-2 text-base">
          <Crosshair className="h-4 w-4" />
          What actually predicts your returns
        </CardTitle>
        <CardDescription>
          The overall grade is one number. These are the five parts of it, and
          whether saying a flaw out loud in the listing changes anything.
        </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={exportFactorsCsv}
              aria-label="Export return rate by grade factor as CSV"
            >
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
            {data.defects.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={exportDisclosureCsv}
                aria-label="Export the defect disclosure comparison as CSV"
              >
                <Download className="mr-2 h-4 w-4" />
                Disclosure CSV
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <div className="space-y-2 px-6 text-sm">
          {nothing ? (
            <p className="text-muted-foreground">
              Nothing has {data.minSample} fulfilled sales on both sides of a
              comparison yet, so there is no finding to report. The bands below
              show the counts.
            </p>
          ) : (
            <>
              {factor && (
                <p>
                  <span className="font-medium">
                    {FACTOR_LABEL[factor.factor]}
                  </span>{" "}
                  is your strongest return signal: items scoring{" "}
                  {factor.worstBand.label.toLowerCase()} come back{" "}
                  <span className="font-medium">
                    {factor.multiplier.toFixed(1)}x
                  </span>{" "}
                  as often as items scoring {factor.bestBand.label.toLowerCase()}
                  .
                </p>
              )}
              {defect && (
                <p>
                  <span className="font-medium">
                    {defectLabel(defect.row.defect)}
                  </span>{" "}
                  returns{" "}
                  <span className="font-medium">
                    {defect.multiplier.toFixed(1)}x
                  </span>{" "}
                  as often when you do not disclose it (
                  {rate(defect.row.undisclosedRate)} versus{" "}
                  {rate(defect.row.disclosedRate)}). Disclosure means a photo
                  tagged as a defect, or the flaw named in the description.
                </p>
              )}
            </>
          )}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Factor</TableHead>
              <TableHead>Band</TableHead>
              <TableHead className="text-right">Fulfilled</TableHead>
              <TableHead className="text-right">Returns</TableHead>
              <TableHead className="pr-6 text-right">Rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.factors.flatMap((f) =>
              f.bands
                .filter((b) => b.fulfilled > 0)
                .map((b, i) => (
                  <TableRow key={`${f.factor}-${b.band}`}>
                    <TableCell className="pl-6 font-medium">
                      {i === 0 ? FACTOR_LABEL[f.factor] : ""}
                    </TableCell>
                    <TableCell>{b.label}</TableCell>
                    <TableCell className="text-right">{b.fulfilled}</TableCell>
                    <TableCell className="text-right">{b.returns}</TableCell>
                    <TableCell className="pr-6 text-right">
                      {b.rate == null ? (
                        <span className="text-muted-foreground">
                          under {data.minSample}
                        </span>
                      ) : (
                        rate(b.rate)
                      )}
                    </TableCell>
                  </TableRow>
                )),
            )}
          </TableBody>
        </Table>

        {data.defects.length > 0 && (
          <>
            <p className="px-6 pt-2 text-sm font-medium">Disclosure</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Defect</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead className="text-right">Disclosed</TableHead>
                  <TableHead className="text-right">Not disclosed</TableHead>
                  <TableHead className="pr-6 text-right">Difference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.defects.map((d) => {
                  const both =
                    d.disclosedRate != null && d.undisclosedRate != null;
                  return (
                    <TableRow key={`${d.defect}|${d.severity}`}>
                      <TableCell className="pl-6 font-medium">
                        {defectLabel(d.defect)}
                      </TableCell>
                      <TableCell>{d.severity}</TableCell>
                      <TableCell className="text-right">
                        {rate(d.disclosedRate)}
                        <span className="block text-xs text-muted-foreground">
                          {d.disclosedCount} sold
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {rate(d.undisclosedRate)}
                        <span className="block text-xs text-muted-foreground">
                          {d.undisclosedCount} sold
                        </span>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        {both && d.disclosedRate! > 0 ? (
                          <Badge variant="outline">
                            {(d.undisclosedRate! / d.disclosedRate!).toFixed(1)}x
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
