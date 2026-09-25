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

// The Referrals tab's own sections (?section=<value>), inside the Account hub.
// A separate param from ?tab= because ?tab= already belongs to the hub, which
// hands an unknown value down to Settings. Email links, Stripe's Connect
// return and support land on a section by URL.
export const REFERRAL_SECTIONS = ["share", "affiliate", "creator", "leaderboard"] as const;
export type ReferralSection = (typeof REFERRAL_SECTIONS)[number];
export const DEFAULT_REFERRAL_SECTION: ReferralSection = "share";

/** Is `v` one of the Referrals sections? */
export function isReferralSection(v: unknown): v is ReferralSection {
  return typeof v === "string" && (REFERRAL_SECTIONS as readonly string[]).includes(v);
}

/** Canonical URL for one Referrals section inside the Account hub. */
export function referralSectionHref(section: ReferralSection): string {
  return `/dashboard/account?tab=referrals&section=${section}`;
}

const REFERRAL_SECTION_META: Record<
  ReferralSection,
  { label: string; keywords: readonly string[] }
> = {
  share: { label: "Referrals: Share", keywords: ["invite", "refer", "referral link", "share link"] },
  affiliate: { label: "Referrals: Affiliate", keywords: ["affiliate", "badge", "payout", "stripe"] },
  creator: { label: "Referrals: Creator", keywords: ["creator", "tax form", "w-9", "commission"] },
  leaderboard: { label: "Referrals: Leaderboard", keywords: ["leaderboard", "top referrers"] },
};

export interface ReferralPaletteAction {
  id: string;
  label: string;
  href: string;
  section: ReferralSection;
  keywords: readonly string[];
}

/** One palette entry per Referrals section. */
export function referralPaletteActions(): ReferralPaletteAction[] {
  return REFERRAL_SECTIONS.map((section) => ({
    id: `referrals-${section}`,
    label: REFERRAL_SECTION_META[section].label,
    href: referralSectionHref(section),
    section,
    keywords: REFERRAL_SECTION_META[section].keywords,
  }));
}

/** Canonical URL for one Settings section inside the Account hub. */
export function settingsTabHref(tab: SettingsTab): string {
  return `/dashboard/account?tab=${tab}`;
}

// Words a seller might type to reach each section from the command palette.
// Lowercase; matched as substrings of the query and the query of them.
const SETTINGS_TAB_KEYWORDS: Record<SettingsTab, readonly string[]> = {
  profile: [
    "name", "photo", "avatar", "business", "ship from", "ship-from",
    "address", "phone", "shipping address",
  ],
  security: ["2fa", "two-factor", "mfa", "password", "sign out", "sessions"],
  notifications: [
    "notifications", "email", "push", "unsubscribe", "marketing", "newsletter",
    "quiet hours", "usage alerts",
  ],
  ai: ["ai limit", "ai cap", "ai actions", "ai allowance", "enrichment"],
  flipdesk: ["listing defaults", "promoted listings", "flipdesk defaults"],
  data: ["export", "download my data", "gdpr", "ccpa", "data request"],
  storage: ["archive photos", "storage", "photo archive"],
  danger: ["delete account", "close account", "erase"],
};

export interface SettingsPaletteAction {
  id: string;
  label: string;
  href: string;
  tab: SettingsTab;
  keywords: readonly string[];
}

/** One palette entry per Settings section: "Settings: <label>". */
export function settingsPaletteActions(): SettingsPaletteAction[] {
  return SETTINGS_TABS.map((t) => ({
    id: `settings-${t.value}`,
    label: `Settings: ${t.label}`,
    href: settingsTabHref(t.value),
    tab: t.value,
    keywords: SETTINGS_TAB_KEYWORDS[t.value],
  }));
}

/** Palette matching: the label or any keyword contains the query. */
export function paletteMatches(
  label: string,
  keywords: readonly string[] | undefined,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (label.toLowerCase().includes(q)) return true;
  if (!q || !keywords) return false;
  return keywords.some((k) => k.includes(q));
}
