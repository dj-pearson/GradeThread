import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import {
  InventoryViewSwitcher,
  type InventoryView,
} from "@/components/flipdesk/inventory-view-switcher";
import { delistRedirectTarget } from "@/lib/delist-links";
import { LoadingRegion, TableLoadingSkeleton } from "@/components/ui/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthStore } from "@/stores/auth-store";
import { useInventorySelection } from "@/stores/inventory-selection";
import { inventoryViewKey, readInventoryView, writeInventoryView } from "./inventory-last-view";
import { SkuExhaustedBanner } from "@/components/flipdesk/sku-auto-hint";

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
// INV-13: one loader per mode, shared by React.lazy and the switcher's
// hover/focus prefetch, so a prefetched chunk is the chunk lazy() resolves.
const LOADERS = {
  table: () => import("./listings").then((m) => ({ default: m.FlipdeskListingsPage })),
  grid: () => import("./grid").then((m) => ({ default: m.FlipdeskGridPage })),
  kanban: () => import("./pipeline").then((m) => ({ default: m.FlipdeskPipelinePage })),
  prep: () => import("./prep").then((m) => ({ default: m.FlipdeskPrepPage })),
} satisfies Record<InventoryView, () => Promise<{ default: () => React.ReactNode }>>;
const TableView = lazy(LOADERS.table);
const GridView = lazy(LOADERS.grid);
const KanbanView = lazy(LOADERS.kanban);
const PrepView = lazy(LOADERS.prep);

function prefetchMode(view: InventoryView) {
  // Fire and forget: a failed prefetch just means lazy() fetches on click.
  void LOADERS[view]().catch(() => {});
}

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
  // INV-2: the shared selection is only valid for the workspace it was made
  // in. Layout effect so a switch clears it before the next paint.
  useLayoutEffect(() => {
    useInventorySelection.getState().bindOwner(ownerId ?? null);
  }, [ownerId]);
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
      <SkuExhaustedBanner />
      {/* INV-13: the shell owns the title and the mode switcher, above the
          Suspense boundary, so a cold switch to another mode keeps the header
          in place instead of blanking the page to a table skeleton. */}
      <div className="mb-6 space-y-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            Find items by stage, then act on one or many.
          </p>
        </div>
        <InventoryViewSwitcher current={mode} onPrefetch={prefetchMode} />
      </div>
      <Suspense fallback={<ModeFallback mode={mode} />}>
        <View />
      </Suspense>
    </>
  );
}

/** INV-13: a loading shape that matches the mode being opened. */
function ModeFallback({ mode }: { mode: InventoryView }) {
  if (mode === "kanban") {
    return (
      <LoadingRegion label="Loading the board" className="grid gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-64 w-full rounded-lg" />
        ))}
      </LoadingRegion>
    );
  }
  if (mode === "prep") {
    return (
      <LoadingRegion label="Loading prep queue" className="space-y-4">
        <Skeleton className="h-64 w-full rounded-lg" />
      </LoadingRegion>
    );
  }
  return (
    <LoadingRegion label="Loading inventory" className="space-y-4">
      <TableLoadingSkeleton
        rows={8}
        columns={mode === "grid" ? 10 : 6}
        className="rounded-lg border"
      />
    </LoadingRegion>
  );
}
