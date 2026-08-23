import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crosshair } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Crosshair className="h-4 w-4" />
          What actually predicts your returns
        </CardTitle>
        <CardDescription>
          The overall grade is one number. These are the five parts of it, and
          whether saying a flaw out loud in the listing changes anything.
        </CardDescription>
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
