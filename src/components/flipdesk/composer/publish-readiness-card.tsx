import { AlertTriangle, Check, CircleHelp, Loader2, MonitorSmartphone } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ChannelReadiness, ReadinessStatus } from "@/lib/publish-readiness";
import { summarizeReadiness } from "@/lib/publish-readiness";

export interface PublishReadinessCardProps {
  rows: ChannelReadiness[];
  /** True while the eBay preflight is in flight, so the card doesn't flash a verdict. */
  loading?: boolean;
}

const STATUS_META: Record<
  ReadinessStatus,
  { label: string; icon: typeof Check; tone: string }
> = {
  ready: { label: "Ready", icon: Check, tone: "text-emerald-600 dark:text-emerald-400" },
  ready_in_browser: {
    label: "Ready — lists in your browser",
    icon: MonitorSmartphone,
    tone: "text-sky-700 dark:text-sky-300",
  },
  blocked: { label: "Will not publish", icon: AlertTriangle, tone: "text-destructive" },
  unchecked: { label: "Can't check", icon: CircleHelp, tone: "text-muted-foreground" },
};

/**
 * US-3202: what happens when you press Publish, before you press it.
 *
 * One row per selected channel. A blocked channel lists its blockers in the
 * validator's own words — the same strings cross-push would return in its 422 —
 * so the seller reads the fix here instead of after a failed fan-out.
 *
 * Warnings sit under blockers and never replace them. A channel with warnings
 * and no blockers still reads as ready, because it is: an empty Fabric Type
 * costs search placement, not the publish.
 */
export function PublishReadinessCard({ rows, loading = false }: PublishReadinessCardProps) {
  if (rows.length === 0) return null;
  const summary = summarizeReadiness(rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Before you publish
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </CardTitle>
        <CardDescription>
          {summary.anyBlocked
            ? `${summary.blocked} of ${rows.length} channels will not publish as this stands.`
            : `All ${rows.length} selected channels look ready.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((row) => {
          const meta = STATUS_META[row.status];
          const Icon = meta.icon;
          return (
            <div
              key={row.platform}
              className={cn(
                "rounded-md border p-2.5",
                row.status === "blocked" && "border-destructive/40 bg-destructive/5",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{row.label}</span>
                <span className={cn("flex items-center gap-1.5 text-xs font-medium", meta.tone)}>
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {meta.label}
                </span>
              </div>

              {row.note && (
                <p className="mt-1.5 text-xs text-muted-foreground">{row.note}</p>
              )}

              {row.blockers.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {row.blockers.map((b) => (
                    <li key={b} className="text-xs text-destructive">
                      {b}
                    </li>
                  ))}
                </ul>
              )}

              {row.warnings.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {row.warnings.map((w) => (
                    <li key={w} className="text-xs text-muted-foreground">
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        {summary.unchecked > 0 && (
          <Badge variant="outline" className="text-[10px]">
            {summary.unchecked} channel{summary.unchecked === 1 ? "" : "s"} can&apos;t be checked ahead of time
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
