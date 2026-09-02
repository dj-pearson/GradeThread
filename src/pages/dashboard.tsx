import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { PwaInstallBanner } from "@/components/flipdesk/pwa-install-banner";
import { CustomizableWidgetBoard } from "@/components/dashboard/customize-board";
import { Button } from "@/components/ui/button";

// US-3075: the grading overview, on the widget board.
//
// This page was thirteen fixed blocks in a fixed order, and every one of them
// is now a registered widget in src/lib/dashboard-widgets.ts. What is left here
// is the two things the board cannot own: the PWA install banner, which is not
// a widget (it is an install affordance that self-hides once dismissed or
// installed and belongs above the board, not inside it), and the page's own
// heading props.
//
// PageHeader is NOT rendered here. CustomizableWidgetBoard renders it, because
// the Customize control has to sit beside the page's own actions and a second
// header would be two places to look for one thing. Passing the title through
// is the whole contract.
//
// Everything else about this page now lives in three files: the registry says
// what a widget is, DEFAULT_LAYOUTS says what order it ships in, and
// dashboard-layout.ts says what a seller's saved arrangement means.

export function DashboardPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="space-y-6">
      {/* US-2108 AC4: the PWA install prompt belongs on a real-install-intent
          surface, not only FlipDesk intake / Snap. The dashboard is where an
          engaged, returning user lands. The banner self-hides unless the browser
          reports the app is installable and shares one dismiss key across mounts,
          so it never nags. `general` variant -> grades/certificates copy. */}
      <PwaInstallBanner variant="general" />

      <CustomizableWidgetBoard
        surface="grading"
        title="Dashboard"
        subtitle={`Welcome back${profile?.full_name ? `, ${profile.full_name}` : ""}.`}
        actions={
          <Button onClick={() => navigate("/dashboard/submissions/new")}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            New Submission
          </Button>
        }
      />
    </div>
  );
}
