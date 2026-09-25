import {
  Sparkles,
  Compass,
  Archive,
  AlertTriangle,
  User,
  Shield,
  Bell,
  Download,
} from "lucide-react";

// US-608: the Settings page's deep-linkable sections (?tab=<value>). Order here
// drives the tab strip. Kept out of the page file so links elsewhere (toasts,
// legal pages, the command palette) can be checked against the real list.
export const SETTINGS_TABS = [
  { value: "profile", label: "Profile", icon: User },
  { value: "security", label: "Security", icon: Shield },
  { value: "notifications", label: "Notifications", icon: Bell },
  { value: "ai", label: "AI", icon: Sparkles },
  { value: "flipdesk", label: "FlipDesk", icon: Compass },
  { value: "data", label: "Data", icon: Download },
  { value: "storage", label: "Storage", icon: Archive },
  { value: "danger", label: "Danger", icon: AlertTriangle },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];
export const SETTINGS_TAB_VALUES = SETTINGS_TABS.map(
  (t) => t.value,
) as SettingsTab[];
export const DEFAULT_SETTINGS_TAB: SettingsTab = "profile";

// The Account hub's own tabs (src/pages/account.tsx). A `?tab=` value that is
// not one of these is handed down to the Settings page, so
// /dashboard/account?tab=security opens Settings on its Security section.
export const ACCOUNT_HUB_TAB_VALUES = [
  "settings",
  "billing",
  "team",
  "api-keys",
  "referrals",
] as const;

/** Canonical URL for one Settings section inside the Account hub. */
export function settingsTabHref(tab: SettingsTab): string {
  return `/dashboard/account?tab=${tab}`;
}
