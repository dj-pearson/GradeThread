import { Outlet } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/error-boundary";

export function RootLayout() {
  return (
    <ErrorBoundary>
      <Outlet />
      <Toaster position="bottom-right" richColors />
    </ErrorBoundary>
  );
}
