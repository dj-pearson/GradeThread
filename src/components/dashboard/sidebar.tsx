import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  FileText,
  Package,
  DollarSign,
  CreditCard,
  Key,
  Settings,
} from "lucide-react";

const navItems = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Overview", end: true },
  { to: "/dashboard/submissions", icon: FileText, label: "Submissions", end: false },
  { to: "/dashboard/inventory", icon: Package, label: "Inventory", end: false },
  { to: "/dashboard/finances", icon: DollarSign, label: "Finances", end: false },
  { to: "/dashboard/billing", icon: CreditCard, label: "Billing", end: false },
  { to: "/dashboard/api-keys", icon: Key, label: "API Keys", end: false },
  { to: "/dashboard/settings", icon: Settings, label: "Settings", end: false },
];

export function Sidebar() {
  return (
    <aside className="hidden w-64 flex-shrink-0 flex-col bg-brand-navy text-white md:flex">
      <div className="flex h-16 items-center px-6">
        <img src="/logo_white.svg" alt="GradeThread" className="h-8" />
      </div>
      <nav className="mt-2 flex-1 space-y-1 px-3">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
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
    </aside>
  );
}
