// GradeThread Lister browser-extension bridge (US-716).
//
// Thin client the FlipDesk Listing Kit uses to hand a per-platform draft to the
// "GradeThread Lister" Chrome extension (extension/). The extension lists from
// the user's OWN logged-in marketplace tab; GradeThread servers never see a
// marketplace password or cookie. On success the kit records the cross-listing
// via the edge writeback endpoint using the user's existing SaaS session.
//
// Gated behind VITE_LISTER_EXTENSION (+ VITE_LISTER_EXTENSION_ID) so the UI
// only shows the control once the extension actually ships — see listing-kit.

import type { MarketplacePlatform } from "@/lib/marketplace-specs";
import { getMarketplaceSpec } from "@/lib/marketplace-specs";
import { orderedCappedPhotos, type ExportablePhoto } from "@/lib/photo-export";
import type { PlatformKitVariant } from "@/hooks/use-autolister";

// Platforms the extension automates (no write API). Depop is excluded — it has
// a partner API path (US-712..714), not the extension path.
export const LISTER_EXTENSION_PLATFORMS = [
  "poshmark",
  "mercari",
  "grailed",
] as const satisfies readonly MarketplacePlatform[];

export type ListerPlatform = (typeof LISTER_EXTENSION_PLATFORMS)[number];

export function isListerPlatform(p: string): p is ListerPlatform {
  return (LISTER_EXTENSION_PLATFORMS as readonly string[]).includes(p);
}

// Where the extension opens the seller's new-listing page per platform.
const NEW_LISTING_URL: Record<ListerPlatform, string> = {
  poshmark: "https://poshmark.com/create-listing",
  mercari: "https://www.mercari.com/sell/",
  grailed: "https://www.grailed.com/sell/",
};

export interface ListerPayload {
  platform: ListerPlatform;
  platformLabel: string;
  itemId: string;
  newListingUrl: string;
  title: string;
  description: string;
  price: string;
  originalPrice: string;
  brand: string;
  color: string;
  size: string;
  category: string;
  condition: string;
  tags: string[];
  photoUrls: string[];
  maxPhotos: number;
}

export interface ListerResult {
  ok: boolean;
  filled?: boolean;
  photosAttached?: boolean;
  listingUrl?: string | null;
  manual?: boolean;
  needsConsent?: boolean;
  timedOut?: boolean;
  error?: string;
  version?: string;
}

// Minimal ambient shape for the bits of the chrome.runtime messaging API we
// use — avoids a hard dependency on @types/chrome in the web tsconfig.
interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (
      extensionId: string,
      message: unknown,
      callback: (response: unknown) => void,
    ) => void;
    lastError?: { message?: string };
  };
}

function chromeRuntime(): ChromeRuntimeLike["runtime"] | undefined {
  const c = (globalThis as unknown as { chrome?: ChromeRuntimeLike }).chrome;
  return c?.runtime;
}

export function listerExtensionId(): string {
  return (import.meta.env.VITE_LISTER_EXTENSION_ID as string | undefined) ?? "";
}

/** True when the Lister UI should be offered (flag on, id set, chrome present). */
export function isListerAvailable(): boolean {
  if (import.meta.env.VITE_LISTER_EXTENSION !== "true") return false;
  if (!listerExtensionId()) return false;
  return typeof chromeRuntime()?.sendMessage === "function";
}

// Pure: assemble the extension payload from a generated per-platform variant +
// the item's photos. Exported for unit testing.
export function buildListerPayload(opts: {
  platform: ListerPlatform;
  itemId: string;
  variant: PlatformKitVariant;
  photos: ExportablePhoto[];
  primaryId: string | null;
}): ListerPayload {
  const spec = getMarketplaceSpec(opts.platform);
  const maxPhotos = spec?.maxPhotos ?? 12;
  const ordered = orderedCappedPhotos(opts.photos, opts.primaryId, opts.platform);
  const v = opts.variant;
  return {
    platform: opts.platform,
    platformLabel: spec?.label ?? opts.platform,
    itemId: opts.itemId,
    newListingUrl: NEW_LISTING_URL[opts.platform],
    title: v.title ?? "",
    description: v.description ?? "",
    price: v.price ? String(v.price) : "",
    originalPrice: "",
    brand: v.brand ?? "",
    color: v.color ?? "",
    size: v.size ?? "",
    category: v.category ?? "",
    condition: v.condition?.label ?? "",
    tags: v.tags ?? [],
    photoUrls: ordered.map((p) => p.photo_url),
    maxPhotos,
  };
}

/** Send a payload to the extension; resolves with its result. */
export function sendToLister(payload: ListerPayload): Promise<ListerResult> {
  return new Promise((resolve) => {
    const runtime = chromeRuntime();
    const id = listerExtensionId();
    if (!runtime?.sendMessage || !id) {
      resolve({ ok: false, error: "GradeThread Lister extension not detected." });
      return;
    }
    let settled = false;
    const done = (r: ListerResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    // Belt-and-braces timeout in case the extension never calls back.
    const timer = window.setTimeout(
      () => done({ ok: false, timedOut: true, error: "The extension didn't respond." }),
      130000,
    );
    try {
      runtime.sendMessage(id, { type: "GT_LISTER_LIST", payload }, (response) => {
        window.clearTimeout(timer);
        if (runtime.lastError) {
          done({
            ok: false,
            error:
              runtime.lastError.message ||
              "Couldn't reach the GradeThread Lister extension.",
          });
          return;
        }
        done((response as ListerResult) ?? { ok: false, error: "Empty response." });
      });
    } catch (err) {
      window.clearTimeout(timer);
      done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
