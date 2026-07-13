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

// US-1882: the gradethread.com bridge content script (gt-bridge.js) drops a
// synchronous DOM marker when our unified extension is installed. This is the
// reliable cross-browser "installed?" signal — Firefox never injects a page-side
// chrome.runtime, and on Chromium chrome.runtime can be present via *another*
// extension. Present in BOTH browsers when our extension is installed.
function bridgeAvailable(): boolean {
  try {
    return (
      typeof document !== "undefined" &&
      document.documentElement?.dataset?.gtExtBridge === "1"
    );
  } catch {
    return false;
  }
}

/** True when the Lister UI should be offered (flag on + a transport is present). */
export function isListerAvailable(): boolean {
  if (import.meta.env.VITE_LISTER_EXTENSION !== "true") return false;
  // Preferred, precise signal (our extension, either browser).
  if (bridgeAvailable()) return true;
  // Chromium externally_connectable fallback (needs the configured id).
  return typeof chromeRuntime()?.sendMessage === "function" && !!listerExtensionId();
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

// US-717: ask the extension to END a live listing on the seller's marketplace
// (cross-listing auto-delist after the item sold elsewhere). Mirrors sendToLister
// but carries the live listing URL instead of a draft payload.
export interface ListerDelistPayload {
  platform: ListerPlatform;
  platformLabel: string;
  listingId: string;
  listingUrl: string;
}

export function sendDelistToLister(
  payload: ListerDelistPayload,
): Promise<ListerResult> {
  return sendExtensionMessage<ListerResult>({ type: "GT_LISTER_DELIST", payload });
}

/** Send a payload to the extension; resolves with its result. */
export function sendToLister(payload: ListerPayload): Promise<ListerResult> {
  return sendExtensionMessage<ListerResult>({ type: "GT_LISTER_LIST", payload });
}

const EXTENSION_TIMEOUT_MS = 130000;

// Response envelope from either transport — a superset of ListerResult so the
// typed lister helpers (and the connect page's GT_SET_TOKEN) share one sender.
export interface ExtensionResponse {
  ok?: boolean;
  error?: string;
  timedOut?: boolean;
  needsConsent?: boolean;
  needsUpgrade?: boolean;
  capabilities?: Record<string, unknown>;
  [key: string]: unknown;
}

// Chromium externally_connectable transport (page → extension by id).
function sendViaRuntime(
  runtime: NonNullable<ChromeRuntimeLike["runtime"]>,
  id: string,
  message: { type: string; [key: string]: unknown },
): Promise<ExtensionResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ExtensionResponse) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(r);
    };
    const timer = window.setTimeout(
      () => done({ ok: false, timedOut: true, error: "The extension didn't respond." }),
      EXTENSION_TIMEOUT_MS,
    );
    try {
      runtime.sendMessage!(id, message, (response) => {
        if (runtime.lastError) {
          done({
            ok: false,
            error: runtime.lastError.message || "Couldn't reach the GradeThread extension.",
          });
          return;
        }
        done((response as ExtensionResponse) ?? { ok: false, error: "Empty response." });
      });
    } catch (err) {
      done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// US-1882: window.postMessage ↔ background bridge (Firefox, and any browser where
// externally_connectable is unavailable). The gradethread.com content script
// (gt-bridge.js) relays the envelope to the background and posts the reply back.
let bridgeSeq = 0;
function sendViaBridge(
  message: { type: string; [key: string]: unknown },
): Promise<ExtensionResponse> {
  return new Promise((resolve) => {
    const reqId = `gt-${Date.now()}-${(bridgeSeq += 1)}`;
    let settled = false;
    const done = (r: ExtensionResponse) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(r);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const d = event.data as
        | { __gtExtRes?: boolean; id?: string; response?: ExtensionResponse }
        | null;
      if (!d || d.__gtExtRes !== true || d.id !== reqId) return;
      done(d.response ?? { ok: false, error: "Empty response." });
    };
    const timer = window.setTimeout(
      () => done({ ok: false, timedOut: true, error: "The extension didn't respond." }),
      EXTENSION_TIMEOUT_MS,
    );
    window.addEventListener("message", onMessage);
    window.postMessage({ __gtExtReq: true, id: reqId, message }, window.location.origin);
  });
}

/**
 * Send a message to the unified extension over the best available transport:
 * Chromium externally_connectable when present, else the gradethread.com
 * postMessage bridge (Firefox). `opts.extensionId` overrides the configured id —
 * the connect page passes the actual install id it received via `?ext=`.
 */
export function sendExtensionMessage<T = ExtensionResponse>(
  message: { type: string; [key: string]: unknown },
  opts?: { extensionId?: string },
): Promise<T> {
  const runtime = chromeRuntime();
  const id = opts?.extensionId || listerExtensionId();
  let p: Promise<ExtensionResponse>;
  if (runtime?.sendMessage && id) p = sendViaRuntime(runtime, id, message);
  else if (bridgeAvailable()) p = sendViaBridge(message);
  else p = Promise.resolve({ ok: false, error: "GradeThread extension not detected." });
  return p as unknown as Promise<T>;
}
