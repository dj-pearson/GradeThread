// US-1802: buyer dashboard navigation model.
//
// The buyer app (/buyer/*) is a surface parallel to the seller dashboard
// (/dashboard/*). Each nav item may declare `requiresFlag` — a BuyerGateFlags
// key — so the sidebar can render it entitlement-aware: unlocked items link
// through; locked items show a lock + route to the buyer billing upgrade prompt
// (US-1800/1801). `feature` is a human label reused by the placeholder pages
// until each feature epic (US-1805…1844) ships its real surface.

import {
  Bell,
  CreditCard,
  Gift,
  LayoutDashboard,
  Megaphone,
  Settings,
  ShieldCheck,
  Shirt,
  type LucideIcon,
} from "lucide-react";
import type { BuyerGateFlags } from "@/lib/constants";

export interface BuyerNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match the active route exactly (react-router NavLink `end`). */
  end?: boolean;
  /** Gate flag that unlocks this item; omit for always-available items. */
  requiresFlag?: keyof BuyerGateFlags;
  /** Short human name used by the shared placeholder page. */
  feature?: string;
}

export const BUYER_NAV: BuyerNavItem[] = [
  { to: "/buyer", label: "Home", icon: LayoutDashboard, end: true },
  {
    to: "/buyer/alerts",
    label: "Watchlist & Alerts",
    icon: Bell,
    requiresFlag: "conditionAlerts",
    feature: "Condition alerts",
  },
  {
    to: "/buyer/rewards",
    label: "Rewards",
    icon: Gift,
    requiresFlag: "rewards",
    feature: "Grade-confirmation rewards",
  },
  {
    to: "/buyer/portfolio",
    label: "Closet Portfolio",
    icon: Shirt,
    requiresFlag: "wardrobePortfolio",
    feature: "Wardrobe portfolio",
  },
  {
    to: "/buyer/guarantee",
    label: "Purchase Guarantee",
    icon: ShieldCheck,
    requiresFlag: "purchaseGuarantee",
    feature: "Grade-locked guarantee",
  },
  {
    to: "/buyer/demand",
    label: "Graded Wanted",
    icon: Megaphone,
    requiresFlag: "demandBoard",
    feature: "Demand board",
  },
  { to: "/buyer/billing", label: "Billing", icon: CreditCard },
  { to: "/buyer/settings", label: "Settings", icon: Settings },
];
