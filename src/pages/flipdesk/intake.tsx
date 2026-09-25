import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router";
import { HostViewSkeleton } from "@/components/flipdesk/host-view-skeleton";
import { IntakeSingleForm } from "@/pages/flipdesk/intake-single";
import { IntakeModeTabs } from "@/components/flipdesk/intake-mode-tabs";

// Bulk and Snap are separate workspaces with their own weight; neither loads
// until its tab is opened, and neither runs the single form's SKU, source,
// review-flow and AI hooks.
const BulkIntake = lazy(() =>
  import("@/components/flipdesk/bulk-intake").then((m) => ({ default: m.BulkIntake })),
);
const SnapCatalog = lazy(() =>
  import("@/components/flipdesk/snap-catalog").then((m) => ({ default: m.SnapCatalog })),
);

/**
 * Add item, routed on ?mode=. The single form stays mounted (hidden) while it
 * holds a draft, so switching to Bulk or Snap and back keeps what was typed
 * and staged. Opened straight into ?mode=bulk, it never mounts at all.
 */
export function FlipdeskIntakePage() {
  const [params] = useSearchParams();
  const mode = params.get("mode");
  const other = mode === "bulk" || mode === "snap" ? mode : null;
  const [draftHeld, setDraftHeld] = useState(false);

  return (
    <div className="space-y-4">
      {/* The same tab row on every mode, and a way to the photo board. */}
      <IntakeModeTabs active={other ?? "single"} />
      {(other === null || draftHeld) && (
        <div hidden={other !== null}>
          <IntakeSingleForm onDirtyChange={setDraftHeld} />
        </div>
      )}
      {other === "bulk" && (
        <Suspense fallback={<HostViewSkeleton label="Loading bulk intake" />}>
          <BulkIntake />
        </Suspense>
      )}
      {other === "snap" && (
        <Suspense fallback={<HostViewSkeleton label="Loading Snap and Catalog" />}>
          <SnapCatalog />
        </Suspense>
      )}
    </div>
  );
}
