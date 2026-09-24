import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A2 (US-3217 rule): the compact failure row for an analytics sub-card.
 *
 * These cards used to return null on a failed read, which drew exactly like a
 * seller with nothing to report. A failed read has to look like a failure and
 * offer a retry, while staying small enough not to push the tab around.
 */
export function AnalyticsCardError({
  title,
  onRetry,
  retrying = false,
  className,
}: {
  title: string;
  onRetry: () => unknown;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 text-sm"
        >
          <p className="flex items-center gap-2 text-muted-foreground">
            <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
            Couldn&apos;t load this.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onRetry()}
            disabled={retrying}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", retrying && "animate-spin")}
              aria-hidden="true"
            />
            Retry
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
