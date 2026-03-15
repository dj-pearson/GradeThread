import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import * as Sentry from "@sentry/react";
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
    console.error("ErrorBoundary caught:", error, errorInfo);
    if (import.meta.env.VITE_SENTRY_DSN) {
      Sentry.captureException(error, {
        extra: { componentStack: errorInfo.componentStack },
      });
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
              <img src="/logo_primary.svg" alt="GradeThread" className="mt-4 h-6" />
              <h3 className="mt-4 text-lg font-medium">Something went wrong</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                An unexpected error occurred. Please try again or return home.
              </p>
              {this.state.error && import.meta.env.DEV && (
                <pre className="mt-4 max-h-32 w-full overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
                  {this.state.error.message}
                </pre>
              )}
              <div className="mt-6 flex gap-3">
                <Button variant="outline" onClick={() => window.location.reload()}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Reload
                </Button>
                <Button variant="outline" onClick={this.handleReset}>
                  Try Again
                </Button>
                <Button onClick={() => (window.location.href = "/")}>
                  <Home className="mr-2 h-4 w-4" />
                  Go Home
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
          <img src="/logo_primary.svg" alt="GradeThread" className="mt-4 h-6" />
          <h3 className="mt-4 text-lg font-medium">Page Error</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            This page encountered an error. Please try again.
          </p>
          <div className="mt-6 flex gap-3">
            <Button variant="outline" onClick={() => window.location.reload()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Reload
            </Button>
            <Button onClick={() => (window.location.href = "/")}>
              <Home className="mr-2 h-4 w-4" />
              Go Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
