import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import type { InventoryView } from "@/components/flipdesk/inventory-view-switcher";

// US-958: one route — /dashboard/flipdesk/inventory — hosts every Inventory
// shape (Triage table / Spreadsheet grid / Kanban pipeline / Prep) as a
// toggleable view MODE rather than four separate routes. The active mode is the
// `?mode=` query param (NOT `?view=`, which is already the saved-view loader),
// so all the other shared params — `tab`, `q` (search), `sort`, `filter` —
// stay in the URL and carry across a mode switch untouched. Selection persists
// via the shared inventory-selection store; status counts via the shared
// useInventoryStatusCounts hook. Each view keeps its own data query (15-min
// staleTime), so flipping modes reuses cached data instead of refetch-storming.
//
// Views are lazy so each mode stays its own chunk (no bundle bloat from
// hosting all four behind one route).
const TableView = lazy(() =>
  import("./listings").then((m) => ({ default: m.FlipdeskListingsPage })),
);
const GridView = lazy(() =>
  import("./grid").then((m) => ({ default: m.FlipdeskGridPage })),
);
const KanbanView = lazy(() =>
  import("./pipeline").then((m) => ({ default: m.FlipdeskPipelinePage })),
);
const PrepView = lazy(() =>
  import("./prep").then((m) => ({ default: m.FlipdeskPrepPage })),
);

function resolveMode(raw: string | null): InventoryView {
  switch (raw) {
    case "grid":
      return "grid";
    case "kanban":
      return "kanban";
    case "prep":
      return "prep";
    default:
      return "table";
  }
}

export function FlipdeskInventoryPage() {
  const [searchParams] = useSearchParams();
  const mode = resolveMode(searchParams.get("mode"));
  const View =
    mode === "grid"
      ? GridView
      : mode === "kanban"
        ? KanbanView
        : mode === "prep"
          ? PrepView
          : TableView;

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-24">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      }
    >
      <View />
    </Suspense>
  );
}
