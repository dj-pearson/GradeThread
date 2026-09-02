import { Link, useSearchParams } from "react-router";
import { Table2, Grid3x3, LayoutGrid, Hammer } from "lucide-react";
import { cn } from "@/lib/utils";

export type InventoryView = "table" | "grid" | "kanban" | "prep";

interface ViewEntry {
  id: InventoryView;
  // The `?mode=` value for this view. Table is the default mode, so it carries
  // no param (a clean /inventory URL).
  mode: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}

// Order matches the user's usual workflow: scan the table, switch to grid
// for visual editing, switch to kanban to track stage progression, hop to
// prep to focus on items that aren't listed yet.
const VIEWS: ViewEntry[] = [
  {
    id: "table",
    mode: "",
    label: "Table",
    icon: Table2,
    description: "Sortable rows, bulk actions",
  },
  {
    id: "grid",
    mode: "grid",
    label: "Grid",
    icon: Grid3x3,
    // It is a spreadsheet, not a photo wall. This used to say "Photo cards,
    // batch edit", which promised a view that does not exist and made the one
    // that does read as broken.
    description: "Spreadsheet, edit cells in bulk",
  },
  {
    id: "kanban",
    mode: "kanban",
    label: "Kanban",
    icon: LayoutGrid,
    description: "Workflow by stage",
  },
  {
    id: "prep",
    mode: "prep",
    label: "Prep",
    icon: Hammer,
    description: "Items not yet listed",
  },
];

interface Props {
  current: InventoryView;
}

// Shared tab strip mounted at the top of every Inventory surface so the four
// views read as one navigable space. US-958: each tab now toggles the `?mode=`
// param on the single /dashboard/flipdesk/inventory route instead of
// navigating to a separate route — so the shared filters/search/sort/tab params
// (and the in-memory selection) survive the switch. Each tab is still a real
// Link so browser back/forward + middle-click open-in-new-tab keep working.
export function InventoryViewSwitcher({ current }: Props) {
  const [searchParams] = useSearchParams();
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-muted/30 p-1">
      {VIEWS.map((v) => {
        const Icon = v.icon;
        const active = v.id === current;
        const next = new URLSearchParams(searchParams);
        if (v.mode) next.set("mode", v.mode);
        else next.delete("mode");
        // Drop the transient saved-view loader param so switching mode doesn't
        // re-apply a saved view on the destination view.
        next.delete("view");
        const qs = next.toString();
        const to = `/dashboard/flipdesk/inventory${qs ? `?${qs}` : ""}`;
        // Plain Link (not NavLink): all four modes share the same pathname and
        // differ only by `?mode=`, so NavLink's pathname-based auto-active would
        // light up every tab. Drive active state off the `current` prop instead.
        return (
          <Link
            key={v.id}
            to={to}
            title={v.description}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {v.label}
          </Link>
        );
      })}
    </div>
  );
}
