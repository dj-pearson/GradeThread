import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
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
              <AlertTriangle className="h-12 w-12 text-destructive" />
              <h3 className="mt-4 text-lg font-medium">Something went wrong</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                An unexpected error occurred. Please try again.
              </p>
              {this.state.error && (
                <pre className="mt-4 max-h-32 w-full overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
                  {this.state.error.message}
                </pre>
              )}
              <div className="mt-6 flex gap-3">
                <Button variant="outline" onClick={this.handleReset}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Try Again
                </Button>
                <Button onClick={() => (window.location.href = "/dashboard")}>
                  Go to Dashboard
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
