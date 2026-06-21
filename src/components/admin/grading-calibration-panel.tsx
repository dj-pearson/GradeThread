import { useQuery } from "@tanstack/react-query";
import { Gauge, Lightbulb, ShieldAlert } from "lucide-react";
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

// US-1113: approved buyer-guarantee-claim-derived per-factor over-grade signal.
interface ClaimFactorSignal {
  factor: string;
  claims: number;
  total_delta: number;
  mean_delta: number;
}
interface ClaimAccuracySignalReport {
  factors: ClaimFactorSignal[];
  total_claims: number;
  total_issues: number;
  mean_overall_delta: number;
}

const FACTOR_LABELS: Record<string, string> = {
  fabric_condition: "Fabric",
  structural_integrity: "Structural",
  cosmetic_appearance: "Cosmetic",
  functional_elements: "Functional",
  odor_cleanliness: "Odor / Cleanliness",
};

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

  const { data: claimSignal } = useQuery({
    queryKey: ["admin-grading-claim-signal"],
    queryFn: async (): Promise<ClaimAccuracySignalReport> => {
      const res = await fetch(`${edgeApiUrl()}/api/admin/grading/claim-signal`, {
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error(`Claim signal unavailable (${res.status})`);
      return res.json();
    },
    staleTime: 60 * 1000,
  });

  const bins = (data?.bins ?? []).filter((b) => b.count > 0);
  const rec = data?.recommended_threshold ?? null;
  const cur = data?.current_threshold ?? 0.75;
  const recDiffers = rec !== null && Math.abs(rec - cur) >= 0.01;

  // US-1113: only surface claim-derived deltas once an approved claim has fed
  // the loop. Factors with no flagging claim are hidden (zero signal).
  const claimFactors = (claimSignal?.factors ?? []).filter((f) => f.claims > 0);
  const hasClaimSignal = (claimSignal?.total_claims ?? 0) > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Gauge className="h-4 w-4 text-brand-navy dark:text-foreground" />
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
              <div className="flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300">
                <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  Grades reach {pct(data.target_agreement)} agreement at{" "}
                  <strong>{pct(rec)}</strong> confidence. Consider setting{" "}
                  <code className="rounded bg-yellow-100 px-1 dark:bg-yellow-950/50">
                    GRADING_REVIEW_CONFIDENCE_THRESHOLD={rec}
                  </code>{" "}
                  ({rec! > cur ? "route more grades to review" : "ship more grades unreviewed"}).
                </span>
              </div>
            )}

            {/* Reliability curve */}
            <div className="overflow-x-auto rounded-lg border">
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

        {/* US-1113: buyer-guarantee-claim → grading-accuracy feedback. Approved
            "the grade was wrong" claims map their claimed issues to grading
            factors; this shows where confirmed claims say grades ran HIGH. */}
        {hasClaimSignal && (
          <div className="space-y-2 rounded-lg border border-brand-red/30 bg-brand-red/5 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-brand-navy dark:text-foreground">
              <ShieldAlert className="h-4 w-4 text-brand-red" />
              Buyer-claim calibration signal
            </div>
            <p className="text-xs text-muted-foreground">
              {claimSignal!.total_claims} approved guarantee claim
              {claimSignal!.total_claims === 1 ? "" : "s"} fed the loop — confirmed
              cases where the item was worse than graded. Implied overall over-grade
              averages{" "}
              <strong>{claimSignal!.mean_overall_delta.toFixed(2)} pts</strong>.
            </p>
            {claimFactors.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border bg-background">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Factor</th>
                      <th className="px-3 py-2 text-right font-semibold">Claims</th>
                      <th className="px-3 py-2 text-right font-semibold">
                        Mean over-grade
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claimFactors.map((f) => (
                      <tr key={f.factor} className="border-t">
                        <td className="px-3 py-2">
                          {FACTOR_LABELS[f.factor] ?? f.factor}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {f.claims}
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {f.mean_delta.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {f.total_delta.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No structured per-factor issues on the approved claims yet.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
