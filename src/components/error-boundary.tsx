import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { captureException } from "@/lib/sentry";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
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
