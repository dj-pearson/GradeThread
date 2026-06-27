// US-1286: AI repair triage panel — recovered-value recommendations.
//
// Surfaces, per reversible/repairable defect, the estimated grade + resale-value
// lift if the seller addresses it, plus a generic (non-affiliated) referral block
// of repair/tailor/cleaning resources. Permanent defects are excluded upstream by
// summarizeRepairTriage, so this panel never makes a repair promise it can't keep.

import { Wrench, TrendingUp, Sparkles, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { summarizeRepairTriage } from "@/lib/repair-triage";
import type { DefectFound } from "@/types/database";

function repairabilityBadgeClasses(r: "reversible" | "repairable"): string {
  return r === "reversible"
    ? "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
    : "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300";
}

export function RepairTriagePanel({
  defects,
  className,
}: {
  defects: DefectFound[] | null | undefined;
  className?: string;
}) {
  const summary = summarizeRepairTriage(defects);
  if (!summary) return null;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wrench className="h-5 w-5 text-brand-navy dark:text-foreground" />
          Recover value with repairs
        </CardTitle>
        <CardDescription>
          Flaws worth addressing — and what fixing them could do to this grade and
          its resale value. Permanent damage isn&apos;t listed here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Headline potential — sum across the actionable defects. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
          <span className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
            <TrendingUp className="h-4 w-4" />
            Up to +{summary.totalGradeLift.toFixed(1)} grade points
          </span>
          <span className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
            <Sparkles className="h-4 w-4" />
            Up to +{summary.totalValueLiftPct}% resale value
          </span>
        </div>

        <ul className="space-y-3">
          {summary.items.map(({ defect, impact }, i) => (
            <li
              key={i}
              className="flex flex-col gap-1.5 border-b pb-3 last:border-b-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn("text-xs capitalize", repairabilityBadgeClasses(impact.repairability))}
                >
                  {impact.repairability}
                </Badge>
                <span className="text-sm font-medium">{defect.defect}</span>
                {defect.location && (
                  <span className="text-xs text-muted-foreground">· {defect.location}</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{impact.action}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                <span>+{impact.gradeLift.toFixed(1)} grade</span>
                <span>+{impact.valueLiftPct}% value</span>
                <span className="text-muted-foreground">via {impact.resource.label}</span>
              </div>
            </li>
          ))}
        </ul>

        {/* Referral block — generic resource categories, no partner dependency. */}
        <div>
          <Separator className="mb-3" />
          <p className="mb-2 text-sm font-medium">Where to get it done</p>
          <ul className="space-y-2">
            {summary.resources.map((r) => (
              <li key={r.label} className="flex items-start gap-2 text-xs text-muted-foreground">
                <Wrench className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>
                  <span className="font-medium text-foreground">{r.label}</span> — {r.hint}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          Projected lifts are estimates based on this grade&apos;s defect analysis.
          Re-grade after a repair to certify the new condition. GradeThread
          isn&apos;t affiliated with any repair provider.
        </p>
      </CardContent>
    </Card>
  );
}
