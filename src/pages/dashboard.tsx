import { useEffect, useMemo } from "react";
import { Link } from "react-router";
import { Plus, Upload } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/stores/auth-store";
import { PwaInstallBanner } from "@/components/flipdesk/pwa-install-banner";
import { CustomizableWidgetBoard } from "@/components/dashboard/customize-board";
import { OverviewViewSwitcher } from "@/components/dashboard/overview-view-switcher";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUrlParamState } from "@/hooks/use-url-param-state";
import { personaOf } from "@/lib/dashboard-layout";
import { OVERVIEW_RANGES } from "@/lib/overview-range";
import { useOverviewRange } from "@/hooks/use-overview-range";
import {
  availableOverviewViews,
  overviewViewDef,
  overviewViewKey,
  readOverviewView,
  resolveOverviewView,
  writeOverviewView,
  OVERVIEW_VIEW_PARAM,
} from "@/lib/overview-view";

// US-3469: ONE Overview, split into a Grading view and a FlipDesk view.
//
// There used to be two. /dashboard was the grading board (US-3075) and
// /dashboard/flipdesk was the FlipDesk board (US-3076), each a thin page over
// CustomizableWidgetBoard, each with its own Customize button. A seller who
// grades AND resells opened two pages every morning and had to remember which
// one a number lived on. Both old URLs redirect here now.
//
// The two views are NOT merged into one board. Each keeps its own surface, so
// each keeps the layout its owner already arranged, in the dashboard_layouts
// row it already had -- that table is keyed by (user, surface), so this page
// needed no migration and took nobody's arrangement away. What is shared is the
// page: one title, one header, one place to go.
//
// The view lives in `?view=`, so a link to "my FlipDesk numbers" is still a
// link. It is also remembered per seller (src/lib/overview-view.ts), so someone
// who lives in FlipDesk opens on FlipDesk without a param and without a
// setting screen. The URL always wins over the memory: a link someone was
// handed has to mean what it says.
//
// PageHeader is NOT rendered here. CustomizableWidgetBoard renders it, so the
// Customize control sits beside this page's own actions; a second header would
// be two places to look for one thing. The view switcher goes through the
// board's `lead` slot for the same reason, and the board hides it while
// customizing so a half-edited draft cannot be swapped out from under itself.

export function DashboardPage() {
  const { profile } = useAuth();
  const userId = useAuthStore((s) => s.user?.id);

  const persona = personaOf(profile?.use_case);
  const views = useMemo(() => availableOverviewViews(persona), [persona]);

  const [viewParam, setViewParam] = useUrlParamState(OVERVIEW_VIEW_PARAM);
  const storageKey = overviewViewKey(userId);
  // Read once per account rather than on every render: the value only changes
  // when this page writes it, and this page already knows when that happened.
  const remembered = useMemo(() => readOverviewView(storageKey), [storageKey]);
  const view = resolveOverviewView(viewParam, remembered, persona);
  const def = overviewViewDef(view);

  // Remember what they are actually looking at, including the view they landed
  // on from a link. Next visit with no param opens here.
  useEffect(() => {
    writeOverviewView(storageKey, view);
  }, [storageKey, view]);

  // Put the resolved view IN the URL, replacing rather than pushing.
  //
  // Two things depend on it. The sidebar decides which Overview row is lit by
  // comparing `?view=` against the link, and with a bare /dashboard rendering a
  // remembered FlipDesk board it would light the Grading row instead. And a
  // seller who copies the address bar for a colleague should be handing over the
  // view they are looking at, not one that resolves against the reader's own
  // memory. This also scrubs a `?view=` that means nothing (a retired value, or
  // FlipDesk on a buyer account).
  useEffect(() => {
    if (viewParam !== view) setViewParam(view);
  }, [viewParam, view, setViewParam]);

  // US-2547: the reporting window, in the URL and remembered per seller.
  // FlipDesk only; see src/hooks/use-overview-range.ts.
  const [range, setRange] = useOverviewRange(view, userId);

  const gradingActions = (
    <Button asChild>
      <Link to="/dashboard/submissions/new">
        <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
        New Submission
      </Link>
    </Button>
  );

  const flipdeskActions = (
    <>
      <Select value={range} onValueChange={setRange}>
        <SelectTrigger className="w-[150px]" aria-label="Reporting period">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OVERVIEW_RANGES.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" asChild>
        <Link to="/dashboard/flipdesk/import">
          <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
          Import
        </Link>
      </Button>
      <Button asChild>
        <Link to="/dashboard/flipdesk/intake">
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          Add item
        </Link>
      </Button>
    </>
  );

  // First name only: "Welcome back, Jordan", not the full legal name the
  // profile carries for certificates.
  const firstName = profile?.full_name?.trim().split(/\s+/)[0] ?? "";
  const greeting = firstName ? `Welcome back, ${firstName}.` : "Welcome back.";

  return (
    <div className="space-y-6">
      {/* US-2108 AC4: the PWA install prompt belongs on a real-install-intent
          surface, not only FlipDesk intake / Snap. The Overview is where an
          engaged, returning user lands. The banner self-hides unless the browser
          reports the app is installable and shares one dismiss key across mounts,
          so it never nags. `general` variant -> grades/certificates copy, and
          the FlipDesk view gets the FlipDesk copy. */}
      <PwaInstallBanner variant={view === "flipdesk" ? "flipdesk" : "general"} />

      <CustomizableWidgetBoard
        surface={def.surface}
        // Keyed by surface so switching views remounts the board. Customize
        // mode holds a draft layout for ONE surface in local state, and
        // carrying that draft across a surface change would offer the grading
        // board FlipDesk widgets to save.
        key={def.surface}
        range={view === "flipdesk" ? range : undefined}
        title="Overview"
        subtitle={
          <>
            <span className="block font-medium text-foreground">{greeting}</span>
            <span className="block">{def.subtitle}</span>
          </>
        }
        lead={
          <OverviewViewSwitcher
            views={views}
            value={view}
            onChange={setViewParam}
          />
        }
        actions={view === "grading" ? gradingActions : flipdeskActions}
      />
    </div>
  );
}
