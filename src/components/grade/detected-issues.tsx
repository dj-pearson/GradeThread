import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DefectFound } from "@/types/database";

// SUB-03: the seller's list of flaws, built from the structured defects_found.
//
// The card it replaces printed detailed_notes whenever no key matched
// "defect", which included the forensic tells and photo-reuse hash notes.
// Those taught an evader what tripped the detector. It also pushed a whole
// semicolon-joined summary into one nowrap badge that clipped.

const SEVERITY_ORDER: Record<DefectFound["severity"], number> = {
  major: 0,
  moderate: 1,
  minor: 2,
};

const SEVERITY_STYLE: Record<
  DefectFound["severity"],
  { label: string; icon: typeof Info; className: string }
> = {
  major: {
    label: "Major",
    icon: AlertCircle,
    className:
      "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  },
  moderate: {
    label: "Moderate",
    icon: AlertTriangle,
    className:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  },
  minor: {
    label: "Minor",
    icon: Info,
    className:
      "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300",
  },
};

/** Defects sorted worst first; unknown severities sort as minor. */
function sortDefectsBySeverity(defects: readonly DefectFound[]): DefectFound[] {
  return [...defects].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2),
  );
}

export function DetectedIssues({ defects }: { defects: readonly DefectFound[] | null | undefined }) {
  const sorted = sortDefectsBySeverity(defects ?? []);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Detected Issues</CardTitle>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            No flaws found
          </p>
        ) : (
          <ul className="space-y-2" aria-label="Detected issues">
            {sorted.map((d, i) => {
              const style = SEVERITY_STYLE[d.severity] ?? SEVERITY_STYLE.minor;
              const Icon = style.icon;
              return (
                <li key={`${d.defect}-${i}`} className="flex items-start gap-2 text-sm">
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
                      style.className,
                    )}
                  >
                    <Icon className="h-3 w-3" aria-hidden="true" />
                    {style.label}
                  </span>
                  <span className="min-w-0 break-words">
                    <span className="font-medium capitalize">{d.defect}</span>
                    {d.location ? (
                      <span className="text-muted-foreground"> · {d.location}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
