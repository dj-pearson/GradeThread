import { lazy, Suspense, useEffect, useRef } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import type { InventoryView } from "@/components/flipdesk/inventory-view-switcher";
import { delistRedirectTarget } from "@/lib/delist-links";
import { LoadingRegion, TableLoadingSkeleton } from "@/components/ui/skeletons";
import { useAuthStore } from "@/stores/auth-store";
import { inventoryViewKey, readInventoryView, writeInventoryView } from "./inventory-last-view";
import { SkuExhaustedBanner } from "@/components/flipdesk/sku-auto-hint";
import { useWorkspace } from "@/hooks/use-workspace";

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
  const userId = useAuthStore(state => state.user?.id);
  const ownerId = useAuthStore(state => state.activeWorkspaceOwnerId) ?? userId;
  return <InventoryWorkspace key={`${userId}:${ownerId}`} storageKey={userId && ownerId ? inventoryViewKey(userId, ownerId) : null} />;
}

function InventoryWorkspace({ storageKey }: { storageKey: string | null }) {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const entryKey = useRef(location.key);
  // Restore only on entry with a bare URL. An explicit bookmark, saved view,
  // workflow link, or a switch back to the default Table always wins.
  const remembered = useRef(storageKey ? readInventoryView(storageKey) : "");
  const restore = location.key === entryKey.current && !location.search && remembered.current;
  // US-3369: the "listing still live" notification lands here; on the web its
  // Delist panel is on the item page, so send the seller there.
  const delistTarget = delistRedirectTarget(searchParams);
  const mode = resolveMode(searchParams.get("mode"));
  // The trigger draws from the OWNER's counter (inventory_items.user_id), so
  // the exhaustion warning has to ask about the owner, not the acting member.
  const { workspaceOwnerId } = useWorkspace();
  const View =
    mode === "grid"
      ? GridView
      : mode === "kanban"
        ? KanbanView
        : mode === "prep"
          ? PrepView
          : TableView;

  useEffect(() => {
    if (storageKey && !restore && !delistTarget) writeInventoryView(storageKey, searchParams);
  }, [storageKey, restore, delistTarget, searchParams]);

  if (delistTarget) return <Navigate to={delistTarget} replace />;
  if (restore) return <Navigate to={`${location.pathname}?${restore}`} replace />;

  return (
    <>
      {/* US-3418: a used-up SKU sequence makes new items save with a BLANK sku
          and says nothing, by design -- US-3415 chose that over failing the
          insert on a seller mid photo session. This is the other half of that
          bargain, and it sits in the shell so it shows on every inventory view
          rather than only on the one the seller happens to be using. */}
      <SkuExhaustedBanner ownerId={workspaceOwnerId ?? undefined} />
      <Suspense
        fallback={
          <LoadingRegion label="Loading inventory" className="space-y-4">
            <TableLoadingSkeleton rows={8} columns={6} className="rounded-lg border" />
          </LoadingRegion>
        }
      >
        <View />
      </Suspense>
    </>
  );
}
