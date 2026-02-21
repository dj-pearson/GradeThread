import { NavLink, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  FileText,
  Package,
  DollarSign,
  Lightbulb,
  CreditCard,
  Key,
  Settings,
  Menu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";

const navItems = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Overview", end: true },
  { to: "/dashboard/submissions", icon: FileText, label: "Submissions", end: false },
  { to: "/dashboard/inventory", icon: Package, label: "Inventory", end: false },
  { to: "/dashboard/finances", icon: DollarSign, label: "Finances", end: false },
  { to: "/dashboard/analytics/suggestions", icon: Lightbulb, label: "Price Suggestions", end: false },
  { to: "/dashboard/billing", icon: CreditCard, label: "Billing", end: false },
  { to: "/dashboard/api-keys", icon: Key, label: "API Keys", end: false },
  { to: "/dashboard/settings", icon: Settings, label: "Settings", end: false },
];

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="mt-2 flex-1 space-y-1 px-3">
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              isActive
                ? "bg-white/15 text-white"
                : "text-white/70 hover:bg-white/10 hover:text-white"
            }`
          }
        >
          <item.icon className="h-5 w-5" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-64 flex-shrink-0 flex-col bg-brand-navy text-white md:flex">
      <div className="flex h-16 items-center px-6">
        <img src="/logo_white.svg" alt="GradeThread" className="h-8" />
      </div>
      <SidebarNav />
    </aside>
  );
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // Close the drawer when the route changes
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <div className="md:hidden">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          className="w-64 bg-brand-navy p-0 text-white [&>button]:text-white"
          showCloseButton
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-16 items-center px-6">
            <img src="/logo_white.svg" alt="GradeThread" className="h-8" />
          </div>
          <SidebarNav onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
