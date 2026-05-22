import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Header } from "@/components/dashboard/header";
import { ErrorBoundary } from "@/components/error-boundary";
import { useRealtimeSubmissions } from "@/hooks/use-realtime-submission";
import { CommandPalette } from "@/components/flipdesk/command-palette";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

export function DashboardLayout() {
  // Subscribe to realtime submission updates for toast notifications
  useRealtimeSubmissions();

  return (
    <div className="flex h-screen overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto bg-background p-6 outline-none"
        >
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      {/* Global Cmd/Ctrl-K command palette */}
      <CommandPalette />
      {/* First-login onboarding */}
      <OnboardingFlow />
    </div>
  );
}
