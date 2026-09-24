import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Clock, PauseCircle, RefreshCw, WifiOff } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SnapError } from "@/hooks/use-snap";

// SNAP-07: every server answer ends in a next step. The page used to match only
// SNAP_LIMIT_REACHED, so the per-network limit, the per-minute limit, the kill
// switch and the budget pause all rendered as the same red dead end.

function useCountdown(seconds: number | undefined, active: boolean): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    if (!active) return;
    setLeft(seconds ?? 60);
    const t = window.setInterval(() => {
      setLeft((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [seconds, active]);
  return left;
}

export function SnapErrorCard({
  error,
  onRetry,
  canRetry,
}: {
  error: SnapError;
  onRetry: () => void;
  canRetry: boolean;
}) {
  const left = useCountdown(error.retryAfterSec, error.kind === "rate");

  const calm = error.kind !== "failed" && error.kind !== "invalid";
  let body: React.ReactNode;
  switch (error.kind) {
    case "limit":
      body = (
        <>
          <p className="text-amber-800 dark:text-amber-300">{error.message}</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link to="/dashboard/account?tab=billing">Upgrade for more snaps</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/dashboard/submissions/new">Get a certified grade</Link>
            </Button>
          </div>
        </>
      );
      break;
    case "rate":
      body = (
        <>
          <p className="flex items-center gap-2">
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
            {left > 0
              ? `That was a lot of snaps in a minute. Try again in ${left}s.`
              : "You can snap again now."}
          </p>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={left > 0 || !canRetry}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> Try again
          </Button>
        </>
      );
      break;
    case "unavailable":
      body = (
        <>
          <p className="flex items-center gap-2">
            <PauseCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            Snap-to-Value is paused for a moment. Your check was not used.
          </p>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={!canRetry}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> Try again
          </Button>
        </>
      );
      break;
    case "network":
      body = (
        <>
          <p className="flex items-center gap-2">
            <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            {error.message}
          </p>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={!canRetry}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> Try again
          </Button>
        </>
      );
      break;
    case "auth":
      body = (
        <>
          <p>{error.message}</p>
          <Button asChild size="sm">
            <Link to="/login">Sign in</Link>
          </Button>
        </>
      );
      break;
    default:
      body = (
        <>
          <p className="text-destructive">{error.message}</p>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={!canRetry}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> Try again
          </Button>
        </>
      );
  }

  return (
    <Card
      role="alert"
      className={cn(
        error.kind === "limit"
          ? "border-amber-300 dark:border-amber-800"
          : calm
            ? "border-border"
            : "border-destructive/40",
      )}
    >
      <CardContent className="space-y-3 p-4 text-sm">{body}</CardContent>
    </Card>
  );
}
