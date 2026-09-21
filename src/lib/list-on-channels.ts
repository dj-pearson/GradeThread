import {
  API_CROSS_LISTING_PLATFORMS,
  EXTENSION_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_EXTENSION_FLOW,
  MARKETPLACE_FLOW_CAPABILITY_LABEL,
  MARKETPLACE_LABELS,
  MARKETPLACE_TIER,
  MARKETPLACE_TIER_LABEL,
  type CrossPushPlatform,
} from "@/lib/constants";
import { filterChannels } from "@/lib/cross-post-channels";
import { type ChannelStatus, planListEverywhere } from "@/lib/channel-state";
import type { CrossPushPlatformResult } from "@/hooks/use-cross-listing";

// US-3450: the one "List on" panel's rows and the one reading of a cross-push
// result. Pure, because the composer had two channel pickers (the API-only
// Push-to card and the kit's extension-only checklist) and each carried its
// own copy of "which channels, and why can't this one be ticked". One list
// here, tested once, offered once.

export interface ListOnRow {
  platform: CrossPushPlatform;
  label: string;
  /** How a tick reaches the marketplace: a server call, or the seller's browser. */
  mechanism: "api" | "extension";
  /**
   * Why the row cannot be ticked, in the words the row shows, or null when it
   * can. Three sources, in this order: the channel is not reachable yet (an
   * API awaiting approval, a lister flow still being verified), or the item is
   * already doing something there (live, queued, ending).
   */
  blocked: string | null;
  status: ChannelStatus | undefined;
}

/**
 * Every channel the seller sells on, API and extension alike, in the order
 * the two old controls showed them (API first), narrowed by the seller's
 * selection exactly as both of them were (US-2721: empty means all).
 */
export function listOnRows(
  chosen: string[] | null | undefined,
  statuses: Record<string, ChannelStatus | undefined>,
): ListOnRow[] {
  const api = filterChannels(API_CROSS_LISTING_PLATFORMS, chosen);
  const ext = filterChannels(EXTENSION_CROSS_LISTING_PLATFORMS, chosen);
  const platforms: CrossPushPlatform[] = [...api, ...ext];
  const byState = planListEverywhere(platforms, statuses).disabled;
  return platforms.map((platform) => {
    const mechanism: ListOnRow["mechanism"] = (api as readonly string[]).includes(platform)
      ? "api"
      : "extension";
    let blocked: string | null = null;
    if (MARKETPLACE_TIER[platform] === "api_pending") {
      blocked = MARKETPLACE_TIER_LABEL.api_pending;
    } else if (
      mechanism === "extension" &&
      MARKETPLACE_EXTENSION_FLOW[platform as keyof typeof MARKETPLACE_EXTENSION_FLOW] !== "live"
    ) {
      // The same words the Marketplaces card shows for a verifying list flow.
      blocked = MARKETPLACE_FLOW_CAPABILITY_LABEL.list.verifying;
    } else if (byState[platform]) {
      blocked = byState[platform];
    }
    return {
      platform,
      label: MARKETPLACE_LABELS[platform] ?? platform,
      mechanism,
      blocked,
      status: statuses[platform],
    };
  });
}

export interface CrossPushSummary {
  /** Published live through an API, this call. */
  published: string[];
  /** Queued for the seller's desktop browser; nothing is live there yet. */
  queued: string[];
  /** Left alone: already live there. */
  live: string[];
  /** Left alone: a job for it is already waiting on the desktop. */
  waiting: string[];
  /** The adapter answered 501: the row exists, publishing there ships later. */
  stubbed: string[];
  /** Refused, with the first blocker in the server's own words. */
  blocked: string[];
}

/**
 * One reading of a cross-push response, shared by the composer's Publish and
 * the panel's own button so the two cannot describe the same result in two
 * vocabularies. Names are the marketplace labels, ready for a toast.
 */
export function summarizeCrossPush(
  results: Partial<Record<CrossPushPlatform, CrossPushPlatformResult>>,
  platforms: readonly CrossPushPlatform[],
): CrossPushSummary {
  const out: CrossPushSummary = {
    published: [],
    queued: [],
    live: [],
    waiting: [],
    stubbed: [],
    blocked: [],
  };
  for (const p of platforms) {
    const r = results[p];
    if (!r) continue;
    const name = MARKETPLACE_LABELS[p] ?? p;
    if (r.skipped === "already_live") out.live.push(name);
    else if (r.skipped === "already_queued") out.waiting.push(name);
    else if (r.ok && r.queued) out.queued.push(name);
    else if (r.ok) out.published.push(name);
    else if (r.status === 501) out.stubbed.push(name);
    else out.blocked.push(`${name}: ${r.blockers?.[0] ?? r.error ?? "failed"}`);
  }
  return out;
}
