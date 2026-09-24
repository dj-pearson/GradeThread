import { registerSW } from "virtual:pwa-register";

let registered = false;

// Registers the FlipDesk service worker. Called once from the intake page so
// the PWA install criteria are met when a reseller is on that screen.
export function ensureServiceWorker(): void {
  if (registered || typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  registered = true;
  registerSW({ immediate: true });
}

// The non-standard event fired by Chromium browsers when the app is
// installable. Captured so we can surface a custom install banner.
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

/**
 * SNAP-12: iOS Safari never fires beforeinstallprompt, so an installable app
 * showed nothing there at all. It gets the manual instruction instead, and only
 * when the page is not already running from the home screen.
 */
export function isIosNotStandalone(): boolean {
  try {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    const ios =
      /iphone|ipad|ipod/i.test(nav.userAgent) ||
      (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
    if (!ios) return false;
    const standalone =
      nav.standalone === true ||
      window.matchMedia?.("(display-mode: standalone)").matches === true;
    return !standalone;
  } catch {
    return false;
  }
}
