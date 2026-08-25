import { useState } from "react";
import { NavLink, useNavigate } from "react-router";
import {
  Boxes,
  DollarSign,
  House,
  Plug,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ADD_MODES, MOBILE_TABS } from "@/lib/mobile-tabs";

// US-2880. Five tabs on a phone, the same five iOS has, in the same order.
//
// Rendered only by DashboardLayout, so the buyer shell (which has its own
// BuyerSidebar) never sees it -- AC5 is structural rather than a media query.
//
// SAFE AREA: the bar sits above the home indicator via
// `env(safe-area-inset-bottom)`, and DashboardLayout adds matching bottom
// padding to <main> so a scrolled list's last row is not hidden behind it.
// Both halves are needed; either one alone looks fine until you scroll.

const ICONS: Record<string, LucideIcon> = {
  Home: House,
  Inventory: Boxes,
  Money: DollarSign,
  Marketplaces: Plug,
};

export function MobileTabBar() {
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="flex items-stretch">
          {MOBILE_TABS.map((tab) => {
            if (tab.kind === "add") {
              return (
                <li key="add" className="flex-1">
                  <button
                    type="button"
                    onClick={() => setAddOpen(true)}
                    aria-label={tab.label}
                    className="flex w-full flex-col items-center gap-0.5 px-1 py-2 text-muted-foreground"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Plus className="h-4 w-4" />
                    </span>
                    <span className="text-[11px] leading-tight">{tab.label}</span>
                  </button>
                </li>
              );
            }
            const Icon = ICONS[tab.label]!;
            return (
              <li key={tab.surface} className="flex-1">
                <NavLink
                  to={tab.to}
                  end={tab.end}
                  className={({ isActive }) =>
                    cn(
                      "flex w-full flex-col items-center gap-0.5 px-1 py-2 text-[11px] leading-tight",
                      isActive ? "text-primary" : "text-muted-foreground",
                    )
                  }
                >
                  <Icon className="h-5 w-5" />
                  <span className="truncate">{tab.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add item</DialogTitle>
            <DialogDescription>
              Three ways in. They all end up in the same place.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {ADD_MODES.map((mode) => (
              <button
                key={mode.label}
                type="button"
                onClick={() => {
                  setAddOpen(false);
                  void navigate(mode.to);
                }}
                className="w-full rounded-lg border border-border p-3 text-left"
              >
                <span className="block font-medium">{mode.label}</span>
                <span className="block text-sm text-muted-foreground">{mode.hint}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
