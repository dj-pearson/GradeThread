// US-9204: the one-screen review flow, the parts that need no React.
//
// Photos come in from web intake (and, once ported, iOS Capture and Android
// capture); one review card comes out: grade, measurements, specifics, title,
// description, price and the channels. One Approve publishes the API channels
// and queues the extension channels for the desktop browser. Everything on the
// card already existed on some FlipDesk page; this file holds the spine's
// decisions so they can be asserted without rendering anything.

import {
  CROSS_LISTING_PLATFORMS,
  LIVE_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_LABELS,
  MARKETPLACE_TIER,
  type CrossListingPlatform,
  type MarketplaceTier,
} from "@/lib/constants";
import { LISTER_EXTENSION_PLATFORMS, type ListerPlatform } from "@/lib/lister-extension";
import { isChannelEnabled } from "@/lib/cross-post-channels";

/**
 * Accounts created on or after this day default to the review flow. Older
 * accounts keep the intake -> item page path and get a one-time "Try the new
 * flow" switch. The date is the ship date of this story on the web.
 */
export const REVIEW_FLOW_SHIP_DATE = "2026-09-01";

/** Default by account age: new accounts on, existing accounts off. */
export function reviewFlowDefault(accountCreatedAt: string | null | undefined): boolean {
  if (!accountCreatedAt) return false;
  const created = Date.parse(accountCreatedAt);
  if (!Number.isFinite(created)) return false;
  return created >= Date.parse(`${REVIEW_FLOW_SHIP_DATE}T00:00:00Z`);
}

/**
 * The seller's stored choice wins; NULL (never chose) falls back to the
 * account-age default. A `false` from an account that defaults on is a real
 * "turn it back", which is the point of the switch.
 */
export function resolveReviewFlow(
  setting: boolean | null | undefined,
  accountCreatedAt: string | null | undefined,
): boolean {
  if (setting === true || setting === false) return setting;
  return reviewFlowDefault(accountCreatedAt);
}

/** The review screen's path. The first-photo time rides along so a reload keeps it. */
export function reviewPath(itemId: string, firstPhotoMs: number | null): string {
  const base = `/dashboard/flipdesk/review/${encodeURIComponent(itemId)}`;
  return firstPhotoMs && Number.isFinite(firstPhotoMs)
    ? `${base}?from=${Math.round(firstPhotoMs)}`
    : base;
}

/**
 * The first-photo time from the intake's staged files: the earliest capture
 * time the browser reports, else the moment the first photo was staged. Phone
 * photos carry a real `lastModified`; a screenshot or a re-saved file carries
 * the save time, which is still "when the photo work began" for this purpose.
 */
export function firstPhotoMsFrom(
  files: ReadonlyArray<{ lastModified?: number }>,
  stagedAtMs: number | null,
): number | null {
  let earliest: number | null = null;
  for (const f of files) {
    const t = typeof f.lastModified === "number" && Number.isFinite(f.lastModified) && f.lastModified > 0
      ? f.lastModified
      : null;
    if (t != null && (earliest == null || t < earliest)) earliest = t;
  }
  if (earliest != null && stagedAtMs != null) return Math.min(earliest, stagedAtMs);
  return earliest ?? stagedAtMs;
}

/** Whole seconds from the first photo to now, never negative, null without a start. */
export function secondsFromFirstPhoto(firstPhotoMs: number | null, nowMs: number): number | null {
  if (firstPhotoMs == null || !Number.isFinite(firstPhotoMs)) return null;
  return Math.max(0, Math.round((nowMs - firstPhotoMs) / 1000));
}

/** Median of a list of seconds; null for an empty list. */
export function medianSeconds(values: ReadonlyArray<number>): number | null {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** "48s", "4m 12s", "1h 3m". Coarse on purpose: this is a habit number, not a stopwatch. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Channels ──────────────────────────────────────────────────────────────

/** How one channel is reached when Approve is pressed. */
export type ReviewChannelMode = "now" | "queued" | "later";

export interface ReviewChannel {
  platform: string;
  label: string;
  tier: MarketplaceTier;
  /** now: a server API publishes it; queued: the desktop extension runs it; later: not live yet. */
  mode: ReviewChannelMode;
}

/**
 * Every channel the review card offers, in display order: the cross-push set
 * (API first) then the extension channels. `chosen` is the seller's
 * cross-post selection (NULL means all, see cross-post-channels.ts); a channel
 * they unticked on the Marketplaces page is not offered here either.
 */
export function reviewChannels(chosen: readonly string[] | null | undefined): ReviewChannel[] {
  const out: ReviewChannel[] = [];
  const seen = new Set<string>();
  const push = (platform: string) => {
    if (seen.has(platform)) return;
    seen.add(platform);
    const tier = MARKETPLACE_TIER[platform as keyof typeof MARKETPLACE_TIER];
    if (!tier || tier === "coming_soon") return;
    if (!isChannelEnabled(platform, chosen ? [...chosen] : null)) return;
    out.push({
      platform,
      label: MARKETPLACE_LABELS[platform as keyof typeof MARKETPLACE_LABELS] ?? platform,
      tier,
      mode: channelMode(platform, tier),
    });
  };
  for (const p of CROSS_LISTING_PLATFORMS) push(p);
  for (const p of LISTER_EXTENSION_PLATFORMS) push(p);
  return out;
}

function channelMode(platform: string, tier: MarketplaceTier): ReviewChannelMode {
  if (tier === "extension") return "queued";
  if (tier === "api" && (LIVE_CROSS_LISTING_PLATFORMS as readonly string[]).includes(platform)) {
    return "now";
  }
  return "later";
}

export function isApiReviewChannel(platform: string): platform is CrossListingPlatform {
  return (LIVE_CROSS_LISTING_PLATFORMS as readonly string[]).includes(platform);
}

export function isQueuedReviewChannel(platform: string): platform is ListerPlatform {
  return (LISTER_EXTENSION_PLATFORMS as readonly string[]).includes(platform);
}

/** Split a selection into what Approve runs now and what it queues. */
export function planApprove(selected: ReadonlySet<string> | readonly string[]): {
  now: CrossListingPlatform[];
  queued: ListerPlatform[];
} {
  const now: CrossListingPlatform[] = [];
  const queued: ListerPlatform[] = [];
  for (const p of selected) {
    if (isApiReviewChannel(p)) now.push(p);
    else if (isQueuedReviewChannel(p)) queued.push(p);
  }
  return { now, queued };
}

/**
 * The sentence under the Approve button. It names what runs now and what
 * waits, and never says "listed" about a queued channel.
 */
export function approveSummary(plan: { now: readonly string[]; queued: readonly string[] }): string {
  const name = (p: string) => MARKETPLACE_LABELS[p as keyof typeof MARKETPLACE_LABELS] ?? p;
  const parts: string[] = [];
  if (plan.now.length > 0) parts.push(`${listNames(plan.now.map(name))} ${plan.now.length === 1 ? "goes" : "go"} live now.`);
  if (plan.queued.length > 0) {
    parts.push(
      `${listNames(plan.queued.map(name))} ${plan.queued.length === 1 ? "waits" : "wait"} for your desktop browser.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : "Pick at least one channel.";
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
