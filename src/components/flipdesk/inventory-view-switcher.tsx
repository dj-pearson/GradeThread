import { NavLink } from "react-router-dom";
import { Table2, Grid3x3, LayoutGrid, Hammer } from "lucide-react";
import { cn } from "@/lib/utils";

export type InventoryView = "table" | "grid" | "kanban" | "prep";

interface ViewEntry {
  id: InventoryView;
  to: string;
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
    to: "/dashboard/flipdesk/inventory",
    label: "Table",
    icon: Table2,
    description: "Sortable rows, bulk actions",
  },
  {
    id: "grid",
    to: "/dashboard/flipdesk/inventory/grid",
    label: "Grid",
    icon: Grid3x3,
    description: "Photo cards, batch edit",
  },
  {
    id: "kanban",
    to: "/dashboard/flipdesk/inventory/kanban",
    label: "Kanban",
    icon: LayoutGrid,
    description: "Workflow by stage",
  },
  {
    id: "prep",
    to: "/dashboard/flipdesk/inventory/prep",
    label: "Prep",
    icon: Hammer,
    description: "Items not yet listed",
  },
];

interface Props {
  current: InventoryView;
}

// Shared tab strip mounted at the top of every Inventory surface so the
// four views read as one navigable space. Each tab is a real Link so
// browser back/forward + middle-click open-in-new-tab work as expected.
export function InventoryViewSwitcher({ current }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-muted/30 p-1">
      {VIEWS.map((v) => {
        const Icon = v.icon;
        const active = v.id === current;
        return (
          <NavLink
            key={v.id}
            to={v.to}
            title={v.description}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {v.label}
          </NavLink>
        );
      })}
    </div>
  );
}
