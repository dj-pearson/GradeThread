import { Link } from "react-router";
import { Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CustomizableWidgetBoard } from "@/components/dashboard/customize-board";
import { useUrlParamState } from "@/hooks/use-url-param-state";
import {
  DEFAULT_OVERVIEW_RANGE,
  isOverviewRangeId,
  OVERVIEW_RANGES,
} from "@/lib/overview-range";

// US-3076: the FlipDesk Overview, on the widget board.
//
// This page was twelve fixed blocks in an order nobody could change, with the
// North Star pinned above the numbers whether or not the seller cared about the
// weekly goal. All thirteen are registered widgets now
// (src/lib/dashboard-widgets.ts) living in src/components/dashboard/widgets/,
// and what is left here is the two things the board cannot own: the reporting
// window, which is a URL param and one of the page's header actions, and the
// page's own heading props.
//
// PageHeader is NOT rendered here. CustomizableWidgetBoard renders it and
// appends its own Customize action to the ones passed in, because the Customize
// control has to sit beside the page's actions; a second header would be two
// places to look for one thing.
//
// The range is passed to the BOARD rather than to each widget. The board builds
// every frame's window subtitle from the widget's own `rangeAware` flag and
// hands the value down, so no widget reaches back into the URL and the picker
// cannot end up meaning two different things in two frames.

export function FlipdeskOverviewPage() {
  // US-2547: the reporting window lives in the URL so a seller can bookmark
  // "last 30 days" and hand the link to a partner.
  const [rangeParam, setRangeParam] = useUrlParamState(
    "range",
    DEFAULT_OVERVIEW_RANGE,
  );
  const range = isOverviewRangeId(rangeParam)
    ? rangeParam
    : DEFAULT_OVERVIEW_RANGE;

  return (
    <div className="space-y-6">
      <CustomizableWidgetBoard
        surface="flipdesk"
        range={range}
        title="Overview"
        subtitle="What's moving, what's stuck, and what's making money."
        actions={
          <>
            <Select value={range} onValueChange={setRangeParam}>
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
        }
      />
    </div>
  );
}
