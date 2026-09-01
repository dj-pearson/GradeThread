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
  // US-2479 / US-2480. Vinted was already advertised as tier `extension` in
  // MARKETPLACE_TIER with nothing behind it here, so a seller who picked it got
  // "Invalid or unsupported listing payload" from the extension — a message that
  // reads as their fault. Facebook moves to the extension tier in the same
  // change. Keep in sync with EXTENSION_DELIST_PLATFORMS in the edge's
  // cross-listing-sale.ts; lister-extension.test.ts asserts the pair.
  "vinted",
  "facebook",
] as const satisfies readonly MarketplacePlatform[];

export type ListerPlatform = (typeof LISTER_EXTENSION_PLATFORMS)[number];

export function isListerPlatform(p: string): p is ListerPlatform {
  return (LISTER_EXTENSION_PLATFORMS as readonly string[]).includes(p);
}

// Where the extension opens the seller's new-listing page per platform.
//
// NOTE (US-1876): this is the SaaS's copy for display and for building the
// payload. The extension does NOT navigate to it — the background resolves the
// target from its own bundled selectors config, precisely so a compromised
// gradethread.com tab cannot steer the browser. If the two ever disagree, the
// extension's copy wins and this one is cosmetic.
const NEW_LISTING_URL: Record<ListerPlatform, string> = {
  poshmark: "https://poshmark.com/create-listing",
  mercari: "https://www.mercari.com/sell/",
  grailed: "https://www.grailed.com/sell/",
  // US-2479: Vinted runs ~20 country domains. This is the default only; the
  // seller's actual locale rides on `ListerPayload.locale` and the extension
  // looks the real URL up in its own map.
  vinted: "https://www.vinted.com/items/new",
  facebook: "https://www.facebook.com/marketplace/create/item",
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
  /**
   * US-2479: which country domain to list on, for the multi-domain platforms
   * (Vinted). A KEY the extension looks up in its bundled locale map — never a
   * URL, so the US-1876 rule that navigation targets come from the extension's
   * own config still holds. Undefined means the platform's default.
   */
  locale?: string;
}

export interface ListerResult {
  ok: boolean;
  filled?: boolean;
  /**
   * 2026-08-11: whether the price field was actually set. `undefined` means an
   * extension old enough not to report it — that must read as "unknown", never
   * as "not filled", or every older install warns on every run. Only an explicit
   * `false` is a real miss (Poshmark, whose price input lives in a dialog that
   * is not on the create page at all).
   */
  priceFilled?: boolean;
  /**
   * US-2730: whether the brand field was set. `undefined` means the channel
   * declares no brand selector, or the draft carries no brand — "not
   * applicable", which must never render as a failure. Only an explicit `false`
   * is a real miss (Poshmark's brand anchor is a placeholder and therefore
   * English-only, so a localised page misses by design).
   */
  brandFilled?: boolean;
  /**
   * US-2737: how many style tags became chips, and how many were offered.
   * Counts rather than a boolean, for the same reason the photos are counted:
   * "2 of 3" is the difference between a seller fixing it now and finding out
   * later. `undefined` where the channel has no tag field.
   */
  tagsCommitted?: number;
  tagsTotal?: number;
  /** True only when EVERY photo landed — see photosTotal/photosFailed (US-1877). */
  photosAttached?: boolean;
  /** US-1877 (AC4): how many photos the fill tried to attach, and how many failed.
   *  A partial attach must read as "6 of 8", never as success. */
  photosTotal?: number;
  photosFailed?: number;
  /**
   * US-2775: attached, but only through the shadow fallback — a subset of the
   * attached count, not a fourth bucket.
   *
   * The browser confirms a direct FileList assignment by populating `value`.
   * When a host refuses that and only `Object.defineProperty` works, `el.files`
   * reports the list while the input's real selection stays empty, so an
   * uploader reading it at submit time sees nothing. Absent means every attached
   * photo was confirmed; older extensions never send it.
   */
  photosUnverified?: number;
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

/**
 * Is OUR extension installed in this browser? (US-2553)
 *
 * Deliberately NOT gated on VITE_LISTER_EXTENSION: that flag decides whether the
 * SELLER cross-listing UI is offered, and a buyer asking "have I installed the
 * extension yet" is a different question with the same answer source — the DOM
 * marker the bridge content script drops on gradethread.com (US-1882), which is
 * the one signal present in both Chrome and Firefox.
 */
export function isExtensionInstalled(): boolean {
  return bridgeAvailable();
}

/**
 * The public Chrome Web Store listing, or null when no extension id is
 * configured (local dev).
 *
 * The buyer home offered "Get the extension" and linked to /buyer/settings,
 * which is not where anyone gets an extension. The id is already configured for
 * the bridge, so the listing URL is derived from it rather than added as a
 * second thing to keep in sync.
 */
export function extensionWebStoreUrl(): string | null {
  const explicit = (import.meta.env.VITE_EXTENSION_WEBSTORE_URL as string | undefined)?.trim();
  if (explicit) return explicit;
  const id = listerExtensionId();
  return id ? `https://chromewebstore.google.com/detail/${id}` : null;
}

/**
 * US-9210: the Firefox Add-ons listing, or null when not configured. Kept as
 * its own variable rather than derived: AMO slugs are chosen at submission and
 * have nothing to do with the Chrome id.
 */
export function extensionAmoUrl(): string | null {
  const explicit = (import.meta.env.VITE_EXTENSION_AMO_URL as string | undefined)?.trim();
  return explicit || null;
}

/** Firefox and its forks say so in the user agent; nothing else does. */
export function isFirefoxUserAgent(ua: string | null | undefined): boolean {
  return /\bFirefox\/\d|\bFxiOS\/|\bSeamonkey\//.test(ua ?? "");
}

/**
 * The store this browser installs from: AMO on Firefox when a listing is
 * configured, else the Chrome Web Store, else null (nothing to link to).
 */
export function extensionStoreUrlFor(ua: string | null | undefined): string | null {
  if (isFirefoxUserAgent(ua)) return extensionAmoUrl() ?? extensionWebStoreUrl();
  return extensionWebStoreUrl() ?? extensionAmoUrl();
}

/** Same, for the browser this code is running in. */
export function extensionStoreUrl(): string | null {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : null;
  return extensionStoreUrlFor(ua);
}

/**
 * WHY cross-listing is unavailable, when it is. (US-2720)
 *
 * `isListerAvailable()` collapses two very different situations into one
 * `false`, and the Listing Kit answered that false by rendering nothing at all.
 * The seller then sees a card offering Copy, Open and Download and concludes
 * cross-listing was never built — which is exactly what happened in production
 * for as long as the two build variables sat blank.
 *
 * Only a cause we can actually check is reported:
 *   "disabled"      — this deployment did not switch the feature on.
 *   "not-installed" — the feature is on and the extension is not here.
 * Anything else (the paid-plan gate, an expired token, unaccepted terms) is
 * knowable only by asking the extension, so it is never guessed at here. The
 * send path reports those, from the extension's own answer.
 */
export type ListerUnavailableReason = "disabled" | "not-installed";

export function listerUnavailableReason(): ListerUnavailableReason | null {
  if (import.meta.env.VITE_LISTER_EXTENSION !== "true") return "disabled";
  if (isListerAvailable()) return null;
  return "not-installed";
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
  /** US-2479: the seller's Vinted country domain, e.g. "vinted.fr". */
  locale?: string;
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
    ...(opts.locale ? { locale: opts.locale } : {}),
  };
}

// US-717: ask the extension to END a live listing on the seller's marketplace
// (cross-listing auto-delist after the item sold elsewhere). Mirrors sendToLister
// but carries the live listing URL instead of a draft payload.
// ── US-9202: edit sync ────────────────────────────────────────────────────
//
// A revise carries the listing's CURRENT FlipDesk values and which of them
// changed. The URL is the listing's own and the extension host-pins it before
// a tab opens, exactly as it does for a delist.
export interface ListerRevisePayload {
  platform: ListerPlatform;
  listingUrl: string;
  listingId: string;
  itemId?: string | null;
  fields: Array<"price" | "title" | "description" | "photos">;
  title?: string | null;
  description?: string | null;
  price?: number | null;
}

export interface ListerReviseResult extends ListerResult {
  revised?: boolean;
  unverified?: boolean;
  partial?: boolean;
  fields?: string[];
}

export function sendReviseToLister(
  payload: ListerRevisePayload,
): Promise<ListerReviseResult> {
  return sendListerJob<ListerReviseResult>({ type: "GT_LISTER_REVISE", payload });
}

// ── US-9203: relist by copying ───────────────────────────────────────────
//
// The server created the copy's row and built this payload; the extension
// opens the OLD listing (host-pinned), follows its copy control, and the
// live-URL watch confirms the new listing to the server when it is posted.
export interface ListerRelistPayload {
  platform: ListerPlatform;
  listingUrl: string;
  listingId: string;
  newListingId: string;
  itemId: string;
  title?: string | null;
  description?: string | null;
  price?: number | null;
}

export interface ListerRelistResult extends ListerResult {
  copied?: boolean;
}

export function sendRelistToLister(
  payload: ListerRelistPayload,
): Promise<ListerRelistResult> {
  return sendListerJob<ListerRelistResult>({ type: "GT_LISTER_RELIST", payload });
}

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
        // US-2724: nothing received the message, so there is no job to wait for.
        // Say so now, and say the true thing — not "the extension didn't report
        // back", which points at a marketplace tab that was never opened.
        if (r && r.undelivered) {
          done({
            ok: false,
            error:
              "Couldn't reach the GradeThread extension. Reload this page and try " +
              "again — if you just installed or reloaded the extension, this tab is " +
              "still running the old copy. If that doesn't help, check the extension " +
              "is installed and switched on.",
          });
          return;
        }
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
  /**
   * US-2724: the message was never DELIVERED — nothing received it, so no job
   * exists and no push will ever arrive. Distinct from `transportError`, which
   * also covers the port dying mid-job while the job is still running.
   *
   * A job send must settle on this immediately. Treating it like a suspended
   * worker means sitting through the full 130s backstop and then telling the
   * seller the extension "didn't report back" and to check a marketplace tab
   * that was never opened — which is exactly what happened in production on
   * 2026-08-20.
   */
  undelivered?: boolean;
  [key: string]: unknown;
}

/**
 * Did this Chrome runtime error mean "nobody received it"? (US-2724)
 *
 * Chrome has two distinct messaging failures and they need opposite handling:
 *
 *   "Could not establish connection. Receiving end does not exist."
 *       No extension with that id is listening. The overwhelmingly common
 *       causes are an id mismatch (the site is configured for the store build
 *       and an unpacked copy is installed, or vice versa) and a disabled
 *       extension. Nothing started, so nothing can finish.
 *
 *   "The message port closed before a response was received."
 *       Something DID receive it and then went away — almost always Chrome
 *       suspending the MV3 worker while a job is still running. The job is
 *       alive and the background will push the result home (US-1874).
 *
 * Matched on the stable substring rather than the whole sentence, which Chrome
 * has reworded before. An unrecognised error is treated as the RECOVERABLE
 * case, because wrongly settling a live job is worse than a slow failure.
 */
export function isUndeliverable(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("receiving end does not exist") ||
    m.includes("could not establish connection") ||
    // US-2733: the DEV case, and the one that hurt. Reloading an unpacked
    // extension orphans the content scripts already running in open tabs: the
    // bridge's DOM marker survives (it was written at document_start and is just
    // an attribute), so the page still believes the relay is there, while the
    // relay's own sendMessage now throws "Extension context invalidated".
    //
    // That is non-delivery as surely as a missing receiver — nothing got the
    // message and no push is coming — but it arrived as a plain transportError,
    // which a job send deliberately does NOT settle on. The result was a spinner
    // running to the full 130s backstop.
    m.includes("extension context invalidated")
  );
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
          // US-1874: one classic case here is "The message port closed before a
          // response was received" — the worker was suspended mid-job. Flagged as a
          // transport error so a job send keeps waiting for the push instead of
          // reporting a failure for a job that is still running.
          //
          // US-2724: the OTHER case is not that at all. "Receiving end does not
          // exist" means the message was never delivered, so there is no job and
          // no push is coming. Both used to hang for 130 seconds.
          const msg = runtime.lastError.message;
          done({
            ok: false,
            transportError: true,
            undelivered: isUndeliverable(msg),
            error: msg || "Couldn't reach the GradeThread extension.",
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
  opts?: { extensionId?: string; preferBridge?: boolean },
): Promise<T> {
  const runtime = chromeRuntime();
  const id = opts?.extensionId || listerExtensionId();
  let p: Promise<ExtensionResponse>;
  // US-2731: the caller knows the configured id is the WRONG address for the
  // install it is talking to — an unpacked or sideloaded build, whose id is not
  // the store one. Addressing the store id anyway reaches an extension that may
  // not be installed at all, which is what "receiving end does not exist" means.
  //
  // The bridge needs no id: gt-bridge.js is injected by whichever build of OUR
  // extension is actually installed and relays over internal messaging, so it
  // cannot deliver to a third party. That makes it the SAFER choice here, not a
  // relaxation — it is the query parameter, not the bridge, that is untrusted.
  if (opts?.preferBridge && bridgeAvailable()) {
    p = sendViaBridge(message);
  } else if (runtime?.sendMessage && id) {
    // US-2724: the id-addressed transport is preferred, but it is addressed by
    // an id that can be WRONG in a way nothing else notices.
    //
    // externally_connectable targets one exact extension id. The bridge does
    // not: gt-bridge.js is injected by whichever build is actually installed
    // and relays over internal messaging, so it reaches the right extension by
    // construction. When the configured id names a build that is not installed
    // — an unpacked dev copy alongside a store id, a sideloaded or
    // enterprise-deployed copy, a stale id after a re-publish — the id path
    // dies and the bridge path would have worked.
    //
    // Falling back ONLY on `undelivered` is what makes this safe. That flag
    // means nothing received the message, so re-sending cannot duplicate a job.
    // A port that closed mid-job is NOT retried here: something did receive it,
    // a job may be running, and a second send would open a second tab.
    p = sendViaRuntime(runtime, id, message).then((r) =>
      r.undelivered && bridgeAvailable() ? sendViaBridge(message) : r,
    );
  } else if (bridgeAvailable()) p = sendViaBridge(message);
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

// ── US-9201: closet import ────────────────────────────────────────────────
//
// The page cannot read a Poshmark tab. It asks the extension, which reads the
// closet tab the seller already has open, posts the batch with its own token,
// and hands back the run id; the page polls the ordinary import endpoints from
// there. `reason` is the extension's word for why nothing was read, and the
// `error` beside it is already the sentence to show.

export type ClosetImportReason =
  | "unsupported"
  | "seller_locked"
  | "needs_sign_in"
  | "no_tab"
  | "no_reader"
  | "human_check"
  | "not_signed_in"
  | "not_own_closet"
  | "not_own_listing"
  | "wrong_page"
  | "nothing_read"
  | "offline"
  | "server"
  | "failed";

export interface ClosetImportResponse extends ExtensionResponse {
  status?: number;
  reason?: ClosetImportReason | null;
  needsSignIn?: boolean;
  /** The server's body: run_id, total_rows, new_rows, known_rows, plan_warning, or an error. */
  result?: {
    run_id?: string;
    platform?: string;
    total_rows?: number;
    new_rows?: number;
    known_rows?: number;
    plan_warning?: string | null;
    error?: string;
    message?: string;
    cap?: string;
    used?: number;
    limit?: number;
  } | null;
  page?: "closet" | "detail";
  listingsRead?: number;
  coverage?: { tilesRead: number; reachedEnd: boolean };
  /** ISO time the extension was installed, kept locally by it until now. */
  installedAt?: string | null;
}

export function sendClosetImport(platform: "poshmark" | "mercari"): Promise<ClosetImportResponse> {
  return sendExtensionMessage<ClosetImportResponse>({ type: "GT_CLOSET_IMPORT", platform });
}

/**
 * The sentence for a closet-import failure, from the reason code alone.
 *
 * The extension answers with its own sentence too, and the two agree on
 * purpose; this copy exists so the page never prints a string that arrived over
 * messaging (US-2869 AC4), and so an older extension build's wording cannot
 * leak onto a newer page.
 */
export function closetImportFailureText(
  reason: ClosetImportReason | null,
  platform: "poshmark" | "mercari",
): string {
  const label = platform === "poshmark" ? "Poshmark" : "Mercari";
  switch (reason) {
    case "unsupported":
      return "Closet import supports Poshmark and Mercari.";
    case "seller_locked":
      return "Closet import is part of a paid FlipDesk plan.";
    case "needs_sign_in":
      return "Sign in to GradeThread in the extension first, then press Import again.";
    case "no_tab":
      return `Open your own ${label} closet in another tab, then press Import again.`;
    case "no_reader":
      return `The ${label} tab has not finished loading. Give it a moment and press Import again.`;
    case "human_check":
      return `${label} is asking you to prove you are a person. Finish that in the tab, then press Import again.`;
    case "not_signed_in":
      return `You are signed out of ${label} in that tab. Sign in there, then press Import again.`;
    case "not_own_closet":
      return `That closet is not yours. Open your own ${label} closet, then press Import again.`;
    case "not_own_listing":
      return `That listing is not yours. Open your own ${label} closet, or one of your own listings, then press Import again.`;
    case "wrong_page":
      return `Open your own ${label} closet page (or one of your own listings) in that tab, then press Import again.`;
    case "offline":
      return "Couldn't reach GradeThread. Check your connection and press Import again.";
    case "server":
    case "failed":
      return "Could not start the import. Try again in a moment.";
    default:
      return `Nothing on that page read as one of your ${label} listings. Scroll so your listings are on screen, then press Import again.`;
  }
}

