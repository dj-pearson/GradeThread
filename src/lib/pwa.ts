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
