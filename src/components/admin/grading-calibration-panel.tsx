import { useQuery } from "@tanstack/react-query";
import { Gauge, Lightbulb } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";

// US-331: confidence reliability curve + recommended review threshold.

interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  mean_confidence: number;
  agreement_rate: number;
  mean_absolute_error: number;
}
interface CalibrationReport {
  bins: CalibrationBin[];
  total: number;
  current_threshold: number;
  recommended_threshold: number | null;
  agreement_at_current: number | null;
  target_agreement: number;
}

function pct(x: number | null): string {
  return x === null || x === undefined ? "—" : `${(x * 100).toFixed(0)}%`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
}

export function GradingCalibrationPanel() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-grading-calibration"],
    queryFn: async (): Promise<CalibrationReport> => {
      const res = await fetch(`${edgeApiUrl()}/api/admin/grading/calibration`, {
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error(`Calibration unavailable (${res.status})`);
      return res.json();
    },
    staleTime: 60 * 1000,
  });

  const bins = (data?.bins ?? []).filter((b) => b.count > 0);
  const rec = data?.recommended_threshold ?? null;
  const cur = data?.current_threshold ?? 0.75;
  const recDiffers = rec !== null && Math.abs(rec - cur) >= 0.01;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Gauge className="h-4 w-4 text-brand-navy" />
          Confidence Calibration
        </CardTitle>
        <CardDescription>
          Does model confidence predict accuracy? Agreement with human reviewers
          by confidence band, and the lowest review threshold that still ships{" "}
          {pct(data?.target_agreement ?? 0.9)}-agreement grades.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Calibration data is temporarily unavailable.
          </p>
        ) : !data || data.total < 10 || bins.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Not enough reviewed grades yet to calibrate confidence. This fills in
            as human reviews accrue.
          </p>
        ) : (
          <>
            {/* Threshold callout */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border p-3 text-sm">
              <div>
                <span className="text-muted-foreground">Current review threshold:</span>{" "}
                <span className="font-semibold">{pct(cur)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Agreement at/above it:</span>{" "}
                <span className="font-semibold">{pct(data.agreement_at_current)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Recommended:</span>{" "}
                <span className="font-semibold">{rec === null ? "—" : pct(rec)}</span>
              </div>
            </div>

            {recDiffers && (
              <div className="flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800">
                <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  Grades reach {pct(data.target_agreement)} agreement at{" "}
                  <strong>{pct(rec)}</strong> confidence. Consider setting{" "}
                  <code className="rounded bg-yellow-100 px-1">
                    GRADING_REVIEW_CONFIDENCE_THRESHOLD={rec}
                  </code>{" "}
                  ({rec! > cur ? "route more grades to review" : "ship more grades unreviewed"}).
                </span>
              </div>
            )}

            {/* Reliability curve */}
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Confidence</th>
                    <th className="px-3 py-2 text-right font-semibold">Grades</th>
                    <th className="px-3 py-2 text-right font-semibold">Agreement</th>
                    <th className="px-3 py-2 text-right font-semibold">MAE</th>
                  </tr>
                </thead>
                <tbody>
                  {bins.map((b) => (
                    <tr key={b.lo} className="border-t">
                      <td className="px-3 py-2">
                        {Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{b.count}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <div
                              className={
                                b.agreement_rate >= (data.target_agreement ?? 0.9)
                                  ? "h-full bg-green-500"
                                  : b.agreement_rate >= 0.7
                                    ? "h-full bg-yellow-500"
                                    : "h-full bg-red-500"
                              }
                              style={{ width: `${Math.round(b.agreement_rate * 100)}%` }}
                            />
                          </div>
                          <span className="w-9 text-right font-medium">
                            {pct(b.agreement_rate)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {b.mean_absolute_error.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
