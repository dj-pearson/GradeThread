import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  isListerAvailable,
  isListerPlatform,
  sendReviseToLister,
} from "@/lib/lister-extension";
import { MARKETPLACE_EXTENSION_FLOWS } from "@/lib/constants";

// US-9202: the pending-revise queue for extension marketplaces.
//
// An edit in FlipDesk reaches eBay and Shopify through their APIs. Poshmark,
// Mercari, Vinted and Grailed have no write API, so the edge can only STAMP the
// listing stale (listings.platform_fields.revise_pending) and the seller's own
// browser applies it: the extension opens the listing, walks into its editor,
// writes the changed fields, saves, and confirms back only with evidence.
//
// The wording rule is the same as the delist queue's, and it matters more here
// because a stale price looks like a live one: a row is "Stale on Poshmark
// since <date>" until the marketplace confirms, and nothing in this hook says
// "updated" before that confirmation arrives.

export type RevisableField = "price" | "title" | "description" | "photos";

export interface PendingRevise {
  listing_id: string;
  platform: string;
  listing_url: string | null;
  listing_status: string | null;
  fields: RevisableField[];
  queued_at: string;
  source: "edit" | "bulk_price" | "automation" | "mobile";
  attempts: number;
  last_error: string | null;
  /** Confirmed-live with a URL and attempts left: the extension can try it. */
  auto_revisable: boolean;
  item_id: string;
  item_title: string | null;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  photo_count: number;
}

export function usePendingRevises(enabled = true) {
  return useQuery({
    queryKey: ["pending_revises"],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<PendingRevise[]> => {
      const res = await edgeFetch("/api/flipdesk/listings/pending-revises", { silentGate: true });
      if (!res.ok) throw new Error("Could not load pending edits.");
      const json = (await res.json()) as { pending?: PendingRevise[] };
      return json.pending ?? [];
    },
  });
}

/** The stale rows for one item, keyed off the shared queue read. */
export function pendingRevisesForItem(pending: readonly PendingRevise[], itemId: string): PendingRevise[] {
  return pending.filter((p) => p.item_id === itemId);
}

/** "Stale on Poshmark since 1 Sep" — the sentence the row shows. */
export function staleSinceLabel(p: PendingRevise, platformLabel: string): string {
  const d = new Date(p.queued_at);
  const when = Number.isFinite(d.getTime())
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "recently";
  return `Stale on ${platformLabel} since ${when}`;
}

/**
 * Is the extension's revise flow switched on for this channel? Read from the
 * constants map (mirrored from selectors.js and drift-tested), so the page can
 * offer "Apply now" only where the extension would do something, and say "edit
 * there" everywhere else.
 */
export function reviseFlowLive(platform: string): boolean {
  const flows = MARKETPLACE_EXTENSION_FLOWS as Record<string, { revise: string } | undefined>;
  return flows[platform]?.revise === "live";
}

export interface QueueReviseInput {
  itemId: string;
  fields: RevisableField[];
}

/**
 * After a save: mark every live extension-channel listing of the item stale.
 * Fire-and-forget from the callers; a failure here means the row does not
 * show stale, which is the same state as before this story and is reported
 * by the toast rather than swallowed.
 */
export function useQueueRevise() {
  const qc = useQueryClient();
  return useMutation<{ queued: string[] }, Error, QueueReviseInput>({
    mutationFn: async ({ itemId, fields }) => {
      const res = await edgeFetch("/api/flipdesk/listings/revise-queue", {
        method: "POST",
        json: { inventory_item_id: itemId, fields },
        silentGate: true,
      });
      if (!res.ok) throw new Error("Could not mark the marketplace copies as needing an update.");
      return (await res.json()) as { queued: string[] };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pending_revises"] });
    },
  });
}

export interface RunReviseResult {
  ok: boolean;
  /** The marketplace confirmed the edit; the marker is cleared. */
  applied?: boolean;
  manual?: boolean;
  unverified?: boolean;
  error?: string;
}

/**
 * Apply one stale listing through the extension, then confirm the outcome to
 * the server. The marker clears ONLY on `applied`; every other outcome keeps
 * the row stale and records the attempt.
 */
export function useRunRevise() {
  const qc = useQueryClient();
  return useMutation<RunReviseResult, Error, PendingRevise>({
    mutationFn: async (item) => {
      if (!isListerPlatform(item.platform)) {
        return { ok: false, manual: true, error: `${item.platform} isn't an extension platform.` };
      }
      if (!item.listing_url || item.listing_status !== "active") {
        return {
          ok: false,
          manual: true,
          error: "GradeThread has no confirmed live link for this listing. Edit it on the marketplace.",
        };
      }
      if (!isListerAvailable()) {
        return { ok: false, manual: true, error: "Install the GradeThread extension in this browser to apply edits." };
      }
      const res = await sendReviseToLister({
        platform: item.platform,
        listingUrl: item.listing_url,
        listingId: item.listing_id,
        itemId: item.item_id,
        fields: item.fields,
        title: item.listing_title,
        description: item.listing_description,
        price: item.listing_price,
      });
      const applied = res.ok === true && res.revised === true;
      // The extension confirms on its own path too; confirming here as well
      // is idempotent and covers an extension build that predates that path.
      await edgeFetch("/api/flipdesk/listings/revise-confirm", {
        method: "POST",
        json: {
          listing_id: item.listing_id,
          applied,
          manual: res.manual === true,
          unverified: res.unverified === true,
          error: typeof res.error === "string" ? res.error : null,
        },
        silentGate: true,
      }).catch(() => undefined);
      return {
        ok: applied,
        applied,
        manual: res.manual === true,
        unverified: res.unverified === true,
        error: typeof res.error === "string" ? res.error : undefined,
      };
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["pending_revises"] });
    },
  });
}

/**
 * The seller did it by hand. This is the ONE path that clears a marker on a
 * person's word rather than the marketplace's, and the button says so.
 */
export function useMarkReviseDone() {
  const qc = useQueryClient();
  return useMutation<void, Error, PendingRevise>({
    mutationFn: async (item) => {
      const res = await edgeFetch("/api/flipdesk/listings/revise-confirm", {
        method: "POST",
        json: { listing_id: item.listing_id, applied: true },
      });
      if (!res.ok) throw new Error("Could not mark the listing updated.");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pending_revises"] });
    },
  });
}
