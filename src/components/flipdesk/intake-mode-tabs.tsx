import { useRef, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { Boxes, Camera, Images, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";

export type IntakeMode = "single" | "snap" | "bulk";

// The photo board that sorts a phone haul into items. It lives under Money >
// Reconcile, and nothing on Add item used to say so.
export const PHOTO_DUMP_PATH = "/dashboard/flipdesk/money?view=reconcile&tab=photos";

const TABS: { id: IntakeMode | "photos"; label: string; to: string; icon: typeof Camera }[] = [
  { id: "single", label: "Single item", to: "/dashboard/flipdesk/intake", icon: SquarePen },
  { id: "snap", label: "Snap", to: "/dashboard/flipdesk/intake?mode=snap", icon: Camera },
  { id: "bulk", label: "Bulk", to: "/dashboard/flipdesk/intake?mode=bulk", icon: Boxes },
  { id: "photos", label: "Photo dump", to: PHOTO_DUMP_PATH, icon: Images },
];

/**
 * One row of tabs for the ways to add an item. It replaces the ad-hoc
 * "Bulk haul mode", "Switch to single item" and "Use the standard intake form"
 * links, which each mode spelled differently. Links rather than buttons, so a
 * mode is a URL; the left and right arrows move between them.
 */
export function IntakeModeTabs({ active }: { active: IntakeMode }) {
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLAnchorElement>, i: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const n = TABS.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : (i - 1 + n) % n;
    refs.current[next]?.focus();
  }

  return (
    <nav aria-label="Ways to add an item" className="overflow-x-auto">
      <ul className="flex w-max gap-1 rounded-lg border bg-muted/40 p-1">
        {TABS.map((t, i) => {
          const current = t.id === active;
          const Icon = t.icon;
          return (
            <li key={t.id}>
              <Link
                ref={(el) => {
                  refs.current[i] = el;
                }}
                to={t.to}
                aria-current={current ? "page" : undefined}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  current
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
