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
  /** True only when EVERY photo landed — see photosTotal/photosFailed (US-1877). */
  photosAttached?: boolean;
  /** US-1877 (AC4): how many photos the fill tried to attach, and how many failed.
   *  A partial attach must read as "6 of 8", never as success. */
  photosTotal?: number;
  photosFailed?: number;
  listingUrl?: string | null;
  manual?: boolean;
  needsConsent?: boolean;
  /**
   * US-1873 seller gate: the account isn't on a paid FlipDesk plan. The background
   * has always returned this; the type just never admitted it.
   */
  needsUpgrade?: boolean;
  timedOut?: boolean;
  /** US-1874: the marketplace tab was closed before the job could finish. */
  tabClosed?: boolean;
  /** US-717/US-1875: the listing was ended AND the deletion was verified. */
  delisted?: boolean;
  /** US-1875: which signal proved the delete took (navigated | gone | toast). */
  verifiedBy?: string;
  /**
   * US-1875: we clicked delete but could NOT confirm it took effect. Always paired
   * with ok:false, which is what keeps the US-1629 pending-delist stamp armed —
   * never report an unverified delist as success, or a sold item stays live.
   */
  unverified?: boolean;
  /**
   * US-1875: a NON-TERMINAL notice (currently a login wall). The job is still
   * queued and will run once the seller signs in — this is not a final outcome.
   */
  pending?: boolean;
  /** US-1875: the marketplace showed a login page; the job was left queued. */
  loginWall?: boolean;
  /**
   * US-1874: the job finished AFTER we had already reported it as timed out. The
   * listing may well exist on the marketplace — the kit surfaces this so the seller
   * doesn't post a duplicate.
   */
  late?: boolean;
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
  return sendListerJob<ListerResult>({ type: "GT_LISTER_DELIST", payload });
}

/** Send a payload to the extension; resolves with its result. */
export function sendToLister(payload: ListerPayload): Promise<ListerResult> {
  return sendListerJob<ListerResult>({ type: "GT_LISTER_LIST", payload });
}

const EXTENSION_TIMEOUT_MS = 130000;

// ── US-1874: durable job-result delivery ──────────────────────────────────
//
// A Lister job outlives the message that started it. Chrome kills an idle MV3
// service worker ~30s after its last event — routinely while a cold marketplace
// tab is still loading — which closes the response port the old code relied on for
// the ONLY copy of the result. The job kept running; its answer had nowhere to go,
// so the promise here hung until the 130s client timeout and the cross-post looked
// like it had silently vanished.
//
// So the background now ALSO pushes every job outcome to the originating
// gradethread.com tab, which the bridge content script relays to this page as a
// `__gtExtPush` window message tagged with the clientRef we minted. We listen for
// that in ADDITION to the callback and take whichever arrives first.

interface JobPushEnvelope {
  __gtExtPush?: boolean;
  clientRef?: string;
  result?: ExtensionResponse;
}

const pushWaiters = new Map<string, (r: ExtensionResponse) => void>();
let pushListenerBound = false;

function bindPushListener(): void {
  if (pushListenerBound || typeof window === "undefined") return;
  pushListenerBound = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const d = event.data as JobPushEnvelope | null;
    if (!d || d.__gtExtPush !== true || typeof d.clientRef !== "string") return;
    const waiter = pushWaiters.get(d.clientRef);
    if (!waiter) return; // not ours, or already settled
    waiter(d.result ?? { ok: false, error: "The extension sent an empty result." });
  });
}

let clientRefSeq = 0;
function makeClientRef(): string {
  return `gtjob-${Date.now()}-${(clientRefSeq += 1)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Send a job-bearing message (list/delist) and resolve with its outcome from
 * whichever delivery path reports first — the response callback (fast, only works
 * while the worker happens to be alive) or the background's push (durable, survives
 * worker death).
 *
 * The critical rule: a `transportError` reply does NOT settle. That reply means the
 * port died, which is precisely the situation the push exists to cover — settling on
 * it would report a failure for a job that is still running and about to succeed.
 */
function sendListerJob<T = ExtensionResponse>(message: {
  type: string;
  [key: string]: unknown;
}): Promise<T> {
  bindPushListener();
  const clientRef = makeClientRef();
  return new Promise<ExtensionResponse>((resolve) => {
    let settled = false;
    const done = (r: ExtensionResponse) => {
      if (settled) return;
      settled = true;
      pushWaiters.delete(clientRef);
      window.clearTimeout(timer);
      resolve(r);
    };
    // Backstop: if BOTH paths are silent (no extension, no bridge, worker gone and
    // the push never lands) the promise still settles rather than hanging forever.
    const timer = window.setTimeout(
      () =>
        done({
          ok: false,
          timedOut: true,
          error: "The extension didn't report back. Check the marketplace tab.",
        }),
      EXTENSION_TIMEOUT_MS,
    );

    pushWaiters.set(clientRef, done);

    sendExtensionMessage<ExtensionResponse>({ ...message, clientRef }).then(
      (r) => {
        // Keep waiting for the push when the transport (not the extension) failed.
        if (r && r.transportError) return;
        done(r);
      },
      (err) => done({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }) as Promise<T>;
}

// Response envelope from either transport — a superset of ListerResult so the
// typed lister helpers (and the connect page's GT_SET_TOKEN) share one sender.
export interface ExtensionResponse {
  ok?: boolean;
  error?: string;
  timedOut?: boolean;
  needsConsent?: boolean;
  needsUpgrade?: boolean;
  capabilities?: Record<string, unknown>;
  /**
   * US-1874: this reply is the TRANSPORT failing, not the extension answering.
   * The overwhelmingly common cause is Chrome killing the MV3 service worker while
   * a Lister job is still running, which closes the response port and invokes our
   * callback with a lastError. The job itself is usually still alive — the
   * background will report it via the durable push — so a job-bearing send must
   * NOT settle on this. See sendListerJob.
   */
  transportError?: boolean;
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
          // US-1874: the classic case here is "The message port closed before a
          // response was received" — the worker was suspended mid-job. Flagged as a
          // transport error so a job send keeps waiting for the push instead of
          // reporting a failure for a job that is still running.
          done({
            ok: false,
            transportError: true,
            error: runtime.lastError.message || "Couldn't reach the GradeThread extension.",
          });
          return;
        }
        done(
          (response as ExtensionResponse) ??
            { ok: false, transportError: true, error: "Empty response." },
        );
      });
    } catch (err) {
      done({
        ok: false,
        transportError: true,
        error: err instanceof Error ? err.message : String(err),
      });
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


// ── US-1877 (AC1): the live-listing capture ───────────────────────────────
//
// A fill ends when the form is prefilled. The seller submits MINUTES later, and
// only then does the marketplace navigate to the new listing — so this cannot ride
// the job promise, which settled long ago. It is a separate, later event: the
// background (watching via tabs.onUpdated, which survives the full page load that
// submitting usually triggers) pushes GT_LISTER_LISTED to the originating tab.
//
// Missing it is expected and fine — the seller may have closed this tab. That is
// what the "I published it" affordance is for; this just saves them the click when
// the tab is still open.

export interface ListerListedEvent {
  platform: string;
  itemId: string | null;
  listingUrl: string;
}

interface ListedPushEnvelope {
  __gtExtPush?: boolean;
  type?: string;
  platform?: string;
  itemId?: string | null;
  listingUrl?: string;
}

/**
 * Subscribe to live-listing captures. Returns an unsubscribe function.
 */
export function onListerListed(cb: (e: ListerListedEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: MessageEvent) => {
    if (event.source !== window) return;
    const d = event.data as ListedPushEnvelope | null;
    if (!d || d.__gtExtPush !== true || d.type !== "GT_LISTER_LISTED") return;
    if (typeof d.listingUrl !== "string" || !d.listingUrl) return;
    cb({
      platform: String(d.platform ?? ""),
      itemId: typeof d.itemId === "string" ? d.itemId : null,
      listingUrl: d.listingUrl,
    });
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
