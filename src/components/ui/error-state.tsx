import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  /** Heading; defaults to a generic outage message. */
  title?: string;
  /** Sub-copy explaining what failed. A support line is appended automatically. */
  description?: string;
  /** Retry handler — typically a TanStack Query `refetch()`. */
  onRetry?: () => void;
  retryLabel?: string;
  /** A retry is in flight: disables the button and spins the icon. */
  retrying?: boolean;
  /** Hide the "contact support" line (e.g. for an inline panel). */
  hideSupport?: boolean;
  className?: string;
}

/**
 * Distinct error state for data surfaces (US-436). Use this — NOT <EmptyState>
 * — when a fetch fails (`isError`), so an outage is never disguised as "no
 * data yet": it shows an alert glyph, a retry button wired to `refetch()`, and
 * a support contact line. It deliberately never renders a "create your first…"
 * CTA. Pair it with <EmptyState> for the genuinely-empty case via
 * <QueryBoundary>, which picks the right one.
 */
export function ErrorState({
  title = "Couldn't load this data",
  description = "Something went wrong while loading. This is usually temporary.",
  onRetry,
  retryLabel = "Try again",
  retrying = false,
  hideSupport = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        className,
      )}
    >
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h3 className="mt-4 text-lg font-medium">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {description}
        {!hideSupport && (
          <>
            {" "}If it keeps happening,{" "}
            <a
              href="mailto:support@gradethread.com"
              className="font-medium underline underline-offset-2 hover:text-foreground"
            >
              contact support
            </a>
            .
          </>
        )}
      </p>
      {onRetry && (
        <Button
          variant="outline"
          className="mt-4"
          onClick={onRetry}
          disabled={retrying}
        >
          <RefreshCw
            className={cn("mr-1.5 h-4 w-4", retrying && "animate-spin")}
          />
          {retrying ? "Retrying…" : retryLabel}
        </Button>
      )}
    </div>
  );
}
