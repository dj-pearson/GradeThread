import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ruler } from "lucide-react";
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
  driftReturnFinding,
  EMPTY_DRIFT,
  measurementLabel,
  quotableDrift,
  significantDrift,
  type MeasurementDrift,
} from "@/lib/measurement-drift";

// US-2827: your medium against everybody else's medium.
//
// The rows are sorted by ABSOLUTE drift, so measuring consistently small shows
// up as loudly as measuring large. Both cost returns; only one of them feels
// like a mistake while you are doing it.

const inches = (n: number | null): string =>
  n == null ? "—" : `${n.toFixed(2)}"`;
const signed = (n: number | null): string =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}"`;
const rate = (n: number | null): string =>
  n == null ? "—" : `${(n * 100).toFixed(1)}%`;

export function MeasurementDriftSection() {
  const user = useAuthStore((s) => s.user);
  const { data = EMPTY_DRIFT } = useQuery<MeasurementDrift>({
    queryKey: ["items_full", "analytics", "measurement-drift", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { fetchMeasurementDrift } = await import("@/lib/measurement-drift");
      return fetchMeasurementDrift(null);
    },
  });

  const rows = useMemo(() => quotableDrift(data), [data]);
  const significant = useMemo(() => significantDrift(data), [data]);
  const returnFinding = useMemo(() => driftReturnFinding(data), [data]);

  if (data.rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Ruler className="h-4 w-4" />
          Measurement drift
        </CardTitle>
        <CardDescription>
          Your median measurement for each size against what other sellers
          record for the same size and garment. Sizes are a brand's opinion; a
          tape measure is not.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <div className="space-y-1 px-6 text-sm">
          {significant.length > 0 ? (
            <p>
              <span className="font-medium">
                {significant.length}{" "}
                {significant.length === 1 ? "measurement" : "measurements"}
              </span>{" "}
              sit more than {data.driftInches}" from the cohort. The widest is{" "}
              {measurementLabel(significant[0]!.key)} on size{" "}
              {significant[0]!.size} at {signed(significant[0]!.driftInches)}.
            </p>
          ) : rows.length > 0 ? (
            <p className="text-muted-foreground">
              Nothing drifts more than {data.driftInches}" from the cohort.
            </p>
          ) : (
            <p className="text-muted-foreground">
              No size has {data.minSellers} other sellers behind it yet, so
              there is nothing to compare against. Your own medians are below.
            </p>
          )}
          {returnFinding && (
            <p>
              Items with a drifted measurement come back{" "}
              <span className="font-medium">
                {returnFinding.multiplier.toFixed(1)}x
              </span>{" "}
              as often ({rate(returnFinding.offRate)} versus{" "}
              {rate(returnFinding.withinRate)}).
            </p>
          )}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Garment</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Measurement</TableHead>
              <TableHead className="text-right">Yours</TableHead>
              <TableHead className="text-right">Cohort</TableHead>
              <TableHead className="text-right">Typical range</TableHead>
              <TableHead className="pr-6 text-right">Drift</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={`${r.garmentCategory}|${r.size}|${r.key}`}>
                <TableCell className="pl-6">{r.garmentCategory}</TableCell>
                <TableCell className="font-medium">{r.size}</TableCell>
                <TableCell>{measurementLabel(r.key)}</TableCell>
                <TableCell className="text-right">
                  {inches(r.ownMedian)}
                  <span className="block text-xs text-muted-foreground">
                    {r.ownCount} items
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  {r.cohortSuppressed ? (
                    <span className="text-muted-foreground">
                      {r.cohortSellers} of {data.minSellers} sellers
                    </span>
                  ) : (
                    inches(r.cohortMedian)
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {r.cohortP25 != null && r.cohortP75 != null
                    ? `${inches(r.cohortP25)} to ${inches(r.cohortP75)}`
                    : "—"}
                </TableCell>
                <TableCell className="pr-6 text-right">
                  {r.driftInches == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : Math.abs(r.driftInches) > data.driftInches ? (
                    <Badge variant="outline">{signed(r.driftInches)}</Badge>
                  ) : (
                    signed(r.driftInches)
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <p className="px-6 text-xs text-muted-foreground">
          Only flat measurements in inches are compared. A US shoe size and a
          watch case diameter are not the same kind of number, so pooling them
          would produce a cohort median for a quantity that has no cohort.
        </p>
      </CardContent>
    </Card>
  );
}
