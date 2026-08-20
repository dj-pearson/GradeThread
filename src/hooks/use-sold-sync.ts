// Sold-sync status and review queue (US-2699).
//
// The server answers both of these from lib/sync-status.ts, the same projection
// the extension popup reads through its own auth dialect. That is deliberate and
// recorded there: a popup that called a channel healthy while this page called
// it failing would make the seller trust neither.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import { sendExtensionMessage } from "@/lib/lister-extension";

/** "poshmark" reads as a database key. Sellers know it as Poshmark. */
function label(platform: string): string {
  return (
    MARKETPLACE_LABELS[platform as keyof typeof MARKETPLACE_LABELS] ?? platform
  );
}

/**
 * `never` is distinct from `ok`, and the UI must keep them distinct.
 *
 * A channel nobody has synced yet is not healthy. Rendering it as healthy is how
 * a seller concludes sold-sync is working when the content script has never once
 * run on their machine.
 */
export type SyncChannelState = "never" | "ok" | "failing" | "not_signed_in";

export interface SyncChannel {
  platform: string;
  status: SyncChannelState;
  failure_reason: string | null;
  listings_seen: number | null;
  last_ok_at: string | null;
  last_read_at: string | null;
  open_reviews: number;
  live_listings: number;
}

export type SyncReviewReason =
  | "probable_match"
  | "unexplained_absence"
  | "count_gap"
  | "circuit_breaker";

export interface SyncReview {
  id: string;
  platform: string;
  reason: SyncReviewReason;
  status: string;
  listing_id: string | null;
  inventory_item_id: string | null;
  listing_url: string | null;
  title: string | null;
  sold_price_cents: number | null;
  sold_at: string | null;
  dedupe_key: string | null;
  unexplained: number | null;
  claimed: number | null;
  cap: number | null;
  created_at: string;
}

export function useSyncStatus(enabled = true) {
  return useQuery({
    queryKey: ["sold_sync_status"],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<SyncChannel[]> => {
      const res = await edgeFetch("/api/flipdesk/sync/status");
      if (!res.ok) throw new Error("Could not load sync status.");
      const json = (await res.json()) as { channels?: SyncChannel[] };
      return json.channels ?? [];
    },
  });
}

export function useSyncReviews(enabled = true) {
  return useQuery({
    queryKey: ["sold_sync_reviews"],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<SyncReview[]> => {
      const res = await edgeFetch("/api/flipdesk/sync/reviews");
      if (!res.ok) throw new Error("Could not load the sync review queue.");
      const json = (await res.json()) as { reviews?: SyncReview[] };
      return json.reviews ?? [];
    },
  });
}

/**
 * Link an unmatched sold row to one of my listings.
 *
 * The server writes listing_url onto that listing, so the NEXT sighting of the
 * same address matches exactly and needs no human at all. It deliberately does
 * not book the sale here.
 */
export function useClaimSyncReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { reviewId: string; listingId: string }) => {
      const res = await edgeFetch(`/api/flipdesk/sync/reviews/${input.reviewId}/claim`, {
        method: "POST",
        body: JSON.stringify({ listing_id: input.listingId }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not link that listing.");
      return json;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sold_sync_reviews"] });
      void qc.invalidateQueries({ queryKey: ["sold_sync_status"] });
    },
  });
}

export function useDismissSyncReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reviewId: string) => {
      const res = await edgeFetch(`/api/flipdesk/sync/reviews/${reviewId}/dismiss`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not dismiss that row.");
      return json;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sold_sync_reviews"] });
      void qc.invalidateQueries({ queryKey: ["sold_sync_status"] });
    },
  });
}

// ── pure presentation helpers, so the copy is testable ─────────────────────

export interface SyncStateCopy {
  label: string;
  /** One line the seller can act on, or null when there is nothing to do. */
  detail: string | null;
  tone: "ok" | "warn" | "idle";
}

/**
 * What a channel's state says to the seller.
 *
 * Pure and exported so the wording is held by a test. The distinction that
 * matters most: "we have never read this" and "we read it and it looked empty"
 * are different sentences with different fixes, and collapsing them sends the
 * seller after the wrong one.
 */
export function syncStateCopy(channel: SyncChannel): SyncStateCopy {
  switch (channel.status) {
    case "ok":
      return {
        label: "Syncing",
        detail: channel.listings_seen === null
          ? null
          : `${channel.listings_seen} listing${channel.listings_seen === 1 ? "" : "s"} seen on the last read`,
        tone: "ok",
      };
    case "failing":
      return {
        label: "Sync failing",
        detail: channel.failure_reason ??
          "The last read did not look like your closet. Nothing was recorded.",
        tone: "warn",
      };
    case "not_signed_in":
      return {
        label: "Not signed in",
        detail: `Open ${label(channel.platform)} in this browser and sign in. Nothing was recorded.`,
        tone: "warn",
      };
    default:
      return {
        label: "Not synced yet",
        detail: channel.live_listings > 0
          ? `Open your ${label(channel.platform)} sold page once and we will start tracking your ${channel.live_listings} listing${channel.live_listings === 1 ? "" : "s"}.`
          : "Nothing to sync here yet.",
        tone: "idle",
      };
  }
}

/** How the three review groups are titled and explained. */
export function reviewGroupCopy(reason: SyncReviewReason): { title: string; blurb: string } {
  switch (reason) {
    case "probable_match":
      return {
        title: "Needs confirming",
        blurb:
          "A sale we could not tie to one of your items with certainty. Confirm the match and we will do it automatically next time.",
      };
    case "unexplained_absence":
      return {
        title: "Gone, reason unknown",
        blurb:
          "These listings vanished from your closet with no matching sale. They may have sold, been removed by you, or been pulled by the marketplace.",
      };
    case "count_gap":
      return {
        title: "More missing than sold",
        blurb:
          "Your closet shrank by more than the sales we found explain. That usually means we are reading fewer sold rows than there really are.",
      };
    case "circuit_breaker":
      return {
        title: "Refused a suspicious read",
        blurb:
          "One read claimed more sales than your closet could plausibly produce, so we recorded none of it. This is almost always a marketplace redesign, not a very good day.",
      };
  }
}

// ── the scheduled poll (US-2701) ───────────────────────────────────────────
//
// The poll's settings live in the EXTENSION's storage, not on the server, so
// this page reaches them through the same bridge the Lister uses rather than
// through an API. That is not an accident of implementation: the consent is
// about what the extension does on the seller's own machine, and putting it on
// a server would make it a setting rather than a permission.
//
// The page can read the state, turn it OFF, and slow it down. It CANNOT turn it
// on. Accepting the clickwrap happens in the extension popup, where the terms
// render from the extension's own copy — a page that could accept would be
// consenting to terms it rendered itself.

export interface PollState {
  available: boolean;
  accepted: boolean;
  enabled: boolean;
  intervalMin: number;
}

export function usePollState(enabled = true) {
  return useQuery({
    queryKey: ["sold_sync_poll_state"],
    enabled,
    staleTime: 30 * 1000,
    queryFn: async (): Promise<PollState | null> => {
      const res = await sendExtensionMessage<{ ok?: boolean; state?: PollState }>({
        type: "GT_WEB_POLL_STATE",
      });
      if (!res || res.ok === false || !res.state) return null;
      return res.state;
    },
  });
}

export function useStopPoll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await sendExtensionMessage<{ ok?: boolean }>({ type: "GT_WEB_POLL_REVOKE" });
      if (!res || res.ok === false) throw new Error("Couldn't reach the extension.");
      return res;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sold_sync_poll_state"] });
    },
  });
}

export function useSetPollInterval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (minutes: number) => {
      const res = await sendExtensionMessage<{ ok?: boolean }>({
        type: "GT_WEB_POLL_INTERVAL",
        minutes,
      });
      if (!res || res.ok === false) throw new Error("Couldn't reach the extension.");
      return res;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sold_sync_poll_state"] });
    },
  });
}

/** Cadences the extension's planner accepts. Mirrors sync/poll-plan.js bounds. */
export const POLL_INTERVAL_CHOICES = [30, 45, 60, 180, 360] as const;
