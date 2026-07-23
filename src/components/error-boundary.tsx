import { Component, useEffect } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { useRouteError, useLocation } from "react-router-dom";
import { captureException } from "@/lib/sentry";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  // When this value changes, a boundary that is currently showing its error
  // state clears it. Wire it to the route (see RouteErrorBoundary) so a single
  // recoverable page error doesn't trap every subsequent in-app navigation
  // behind the "Something went wrong" card until a full reload.
  resetKey?: unknown;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // US-784: Sentry is the production record; the console line is a dev-only
    // breadcrumb (otherwise it just duplicates the captured error in prod logs).
    if (import.meta.env.DEV) {
      console.error("ErrorBoundary caught:", error, errorInfo);
    }
    // Lazy-loads @sentry/react on first capture (no-op without a DSN) so the
    // eager graph stays slim — see lib/sentry.ts.
    captureException(error, {
      extra: { componentStack: errorInfo.componentStack },
    });
  }

  componentDidUpdate(prevProps: Props) {
    // Clear the error when the route changes so navigating away from a broken
    // page recovers the app. Only touches state while an error is showing, so
    // the happy path re-renders normally (no forced child remount).
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-[400px] items-center justify-center p-6">
          <Card className="w-full max-w-md">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-8 w-8 text-destructive" />
              </div>
              <img
                src="/logo_primary.png"
                alt="GradeThread"
                className="mt-4 h-6"
                onError={(e) => {
                  // US-785: the error page must never itself show a broken image.
                  // If the logo can't load, replace it with a plain text wordmark.
                  const img = e.currentTarget;
                  const span = document.createElement("span");
                  span.textContent = "GradeThread";
                  span.className = "mt-4 text-sm font-bold text-brand-navy dark:text-foreground";
                  img.replaceWith(span);
                }}
              />
              <h3 className="mt-4 text-lg font-medium">Something went wrong</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                An unexpected error occurred. Please try again or return home.
              </p>
              {this.state.error && import.meta.env.DEV && (
                <pre className="mt-4 max-h-32 w-full overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
                  {this.state.error.message}
                </pre>
              )}
              {/* US-450: one clear primary action (reload — the most reliable
                  recovery); "Go home" de-emphasized as a ghost button. */}
              <div className="mt-6 flex flex-col items-center gap-2">
                <Button onClick={() => window.location.reload()}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Try again
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => (window.location.href = "/")}
                >
                  <Home className="mr-2 h-4 w-4" />
                  Go home
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

/** Standalone fallback for React Router errorElement */
export function RouteErrorFallback() {
  const error = useRouteError();

  // US-2027: REPORT it. The class ErrorBoundary above calls captureException,
  // but this router-level fallback did not — so every route error rendered this
  // card with ZERO telemetry. The sharpest case is /embed/grade/:id, which is
  // mounted OUTSIDE RootLayout and therefore has no class boundary above it: a
  // white-label partner iframe could be broken indefinitely with nobody knowing.
  //
  // useRouteError() also catches thrown Responses (a 404/500 from a loader),
  // which are NOT Errors — normalize so Sentry gets something useful rather
  // than "[object Object]".
  useEffect(() => {
    if (!error) return;
    const normalized = error instanceof Error
      ? error
      : new Error(
        typeof error === "object" && error !== null && "status" in error
          ? `Route error: HTTP ${(error as { status?: unknown }).status} ${
            String((error as { statusText?: unknown }).statusText ?? "")
          }`.trim()
          : `Route error: ${String(error)}`,
      );
    captureException(normalized, {
      tags: { source: "RouteErrorFallback" },
      extra: {
        // The embed route has no boundary above it, so knowing WHERE this fired
        // is the difference between a triaged partner outage and a mystery.
        pathname: typeof window !== "undefined" ? window.location.pathname : undefined,
      },
    });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-8 w-8 text-destructive" />
          </div>
          <img src="/logo_primary.png" alt="GradeThread" className="mt-4 h-6" />
          <h3 className="mt-4 text-lg font-medium">Page Error</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            This page encountered an error. Please try again.
          </p>
          {/* US-450: consistent with the ErrorBoundary fallback — single
              primary action, de-emphasized secondary. */}
          <div className="mt-6 flex flex-col items-center gap-2">
            <Button onClick={() => window.location.reload()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Try again
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => (window.location.href = "/")}
            >
              <Home className="mr-2 h-4 w-4" />
              Go home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * ErrorBoundary that resets itself on client-side navigation. Reads the current
 * pathname and feeds it as `resetKey`, so once a page throws, navigating to any
 * other route clears the boundary instead of leaving the "Something went wrong"
 * card rendered over every subsequent in-app link until a full reload.
 */
export function RouteErrorBoundary({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname} fallback={fallback}>
      {children}
    </ErrorBoundary>
  );
}
