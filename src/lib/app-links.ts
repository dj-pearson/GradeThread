// Where GradeThread ships, in one place. (US-3110)
//
// The iOS app and the browser extension are PUBLISHED products, so their store
// URLs are facts about the product rather than deployment configuration. They
// live here as constants, and every surface that offers a download reads them
// from here: the marketing footer, the landing footer, the dashboard widget,
// the onboarding welcome, and the marketing install CTA.
//
// An env var still wins where one is set, so a staging build can point at an
// unlisted item. What US-3110 changed is the FALLBACK. It used to be null, and
// null is what a deployment with a blank VITE_LISTER_EXTENSION_ID got — which
// is why "Add to Chrome" shipped with nowhere to go for as long as those two
// build variables sat empty (the same defect US-2718 AC4 and US-2720 chased in
// the cross-listing UI). A published store URL is a better default than a hole.
//
// This module imports nothing. lister-extension.ts depends on it, not the other
// way round, so there is no cycle.

/** The App Store listing for the native iOS app. */
export const APP_STORE_URL = "https://apps.apple.com/us/app/gradethread/id6774291633";

/** The Chrome Web Store listing for "GradeThread — Grade & List". */
export const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/gradethread-grade-list/apinefjjagmigmobdlbiilhbjebmjkdh";

/**
 * The Firefox Add-ons (AMO) listing.
 *
 * Its own constant rather than something derived from the Chrome id: an AMO
 * slug is chosen at submission and has nothing to do with a Chrome extension
 * id, so the two can never be built from one another.
 */
export const FIREFOX_ADDON_URL =
  "https://addons.mozilla.org/en-US/firefox/addon/gradethread-grade-list/";

/** The App Store link for this build. */
export function appStoreUrl(): string {
  const explicit = (import.meta.env.VITE_IOS_APP_STORE_URL as string | undefined)?.trim();
  return explicit || APP_STORE_URL;
}

/**
 * The Chrome Web Store link for this build.
 *
 * Resolution order: an explicit override, then the listing derived from the
 * extension id the bridge already needs, then the published listing. The
 * derived middle step is kept because a build pointed at an unlisted test
 * extension sets the id and nothing else.
 */
export function chromeWebStoreUrl(): string {
  const explicit = (import.meta.env.VITE_EXTENSION_WEBSTORE_URL as string | undefined)?.trim();
  if (explicit) return explicit;
  const id = (import.meta.env.VITE_LISTER_EXTENSION_ID as string | undefined)?.trim();
  if (id) return `https://chromewebstore.google.com/detail/${id}`;
  return CHROME_WEB_STORE_URL;
}

/** The Firefox Add-ons link for this build. */
export function firefoxAddonUrl(): string {
  const explicit = (import.meta.env.VITE_EXTENSION_AMO_URL as string | undefined)?.trim();
  return explicit || FIREFOX_ADDON_URL;
}

/** Firefox and its forks say so in the user agent; nothing else does. */
export function isFirefoxUa(ua: string | null | undefined): boolean {
  return /\bFirefox\/\d|\bFxiOS\/|\bSeamonkey\//.test(ua ?? "");
}

/** iPhone and iPad, including iPadOS, which reports itself as a Mac with touch. */
export function isIosUa(ua: string | null | undefined): boolean {
  const s = ua ?? "";
  if (/\biPhone\b|\biPad\b|\biPod\b/.test(s)) return true;
  // iPadOS 13+ sends a desktop Safari user agent with no iPad in it. There is
  // no string that separates it from a Mac, so it is not guessed at: an iPad
  // reading the site sees the App Store link second rather than first, and the
  // link is still there. Ordering is a convenience, never a gate.
  return false;
}

export type AppLinkId = "ios" | "chrome" | "firefox";

export interface AppLink {
  id: AppLinkId;
  /** Short label, for a footer row. */
  label: string;
  /** Button text, where there is room for a verb. */
  cta: string;
  /** One line saying what it actually does, for a card. */
  blurb: string;
  href: string;
}

/**
 * Every place GradeThread can be installed, in a fixed order.
 *
 * Fixed on purpose. `appLinksFor` reorders it by user agent for a card that
 * shows one primary choice, but a footer lists all three every time — a
 * reseller reads the site on a laptop and installs the app on a phone, so
 * hiding the App Store link on desktop hides it from the person it is for.
 */
export function appLinks(): AppLink[] {
  return [
    {
      id: "ios",
      label: "iPhone app",
      cta: "Download on the App Store",
      blurb: "Photograph, grade and list a garment from your phone, anywhere you source.",
      href: appStoreUrl(),
    },
    {
      id: "chrome",
      label: "Chrome extension",
      cta: "Add to Chrome",
      blurb: "Grade and cross-list from the marketplace tab you are already in.",
      href: chromeWebStoreUrl(),
    },
    {
      id: "firefox",
      label: "Firefox add-on",
      cta: "Add to Firefox",
      blurb: "The same grading and cross-listing tools, in Firefox.",
      href: firefoxAddonUrl(),
    },
  ];
}

/**
 * The same three, ordered so the one this visitor can actually install comes
 * first. Nothing is dropped — see the note on `appLinks`.
 */
export function appLinksFor(ua: string | null | undefined): AppLink[] {
  const links = appLinks();
  const first: AppLinkId = isIosUa(ua) ? "ios" : isFirefoxUa(ua) ? "firefox" : "chrome";
  return [...links].sort((a, b) => Number(b.id === first) - Number(a.id === first));
}
