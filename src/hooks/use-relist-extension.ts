import { useMutation, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  isListerAvailable,
  isListerPlatform,
  type ListerRelistPayload,
  sendRelistToLister,
} from "@/lib/lister-extension";

// US-9203: relist on the extension channels.
//
// eBay relists under its offer (use-ebay's publish with relist). Poshmark and
// Mercari relist by the seller's browser copying the listing: the server makes
// the copy's row and the job, this hands the job to the extension in THIS
// browser, or queues it for the desktop when the extension is not here. The
// old row is ended by the server only when the copy is live, so nothing on
// this side says "relisted" before then.

export interface RelistExtensionResult {
  ok: boolean;
  /** The copy's form was opened in the seller's browser. */
  copied?: boolean;
  /** No extension here; the job waits for the desktop. */
  queued?: boolean;
  manual?: boolean;
  error?: string;
  newListingId?: string;
}

interface RelistExtensionResponse {
  ok: true;
  new_listing_id: string;
  payload: ListerRelistPayload;
  queue_id: string | null;
}

export function useRelistExtension() {
  const qc = useQueryClient();
  return useMutation<RelistExtensionResult, Error, { listingId: string; platform: string }>({
    mutationFn: async ({ listingId, platform }) => {
      if (!isListerPlatform(platform)) {
        return { ok: false, manual: true, error: `${platform} does not relist through the extension.` };
      }
      const extensionHere = isListerAvailable();
      const res = await edgeFetch(
        `/api/flipdesk/listings/${encodeURIComponent(listingId)}/relist-extension${extensionHere ? "" : "?queue=1"}`,
        { method: "POST" },
      );
      const json = (await res.json().catch(() => ({}))) as Partial<RelistExtensionResponse> & { error?: string };
      if (!res.ok || !json.new_listing_id || !json.payload) {
        throw new Error("Could not start the relist.");
      }
      if (!extensionHere) {
        return { ok: true, queued: true, newListingId: json.new_listing_id };
      }
      const out = await sendRelistToLister(json.payload);
      return {
        ok: out.ok === true && out.copied === true,
        copied: out.copied === true,
        manual: out.manual === true,
        error: typeof out.error === "string" ? out.error : undefined,
        newListingId: json.new_listing_id,
      };
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["items_full"] });
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
    },
  });
}

export interface BulkRelistRowResult {
  listing_id: string;
  ok: boolean;
  mode?: "ebay" | "queued";
  new_listing_id?: string;
  error?: string;
}

export interface BulkRelistResponse {
  ok: true;
  total: number;
  succeeded: number;
  failed: number;
  /** Extension rows waiting for the desktop; eBay rows are relisted already. */
  queued: number;
  results: BulkRelistRowResult[];
}

/** Same chunking as bulk price. Mirrors MAX_BULK_EDIT_ITEMS on the server. */
export const BULK_RELIST_CHUNK_SIZE = 25;

export function chunkForBulkRelist<T>(items: readonly T[], size = BULK_RELIST_CHUNK_SIZE): T[][] {
  if (size < 1) return items.length > 0 ? [[...items]] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function mergeBulkRelistResponses(parts: readonly BulkRelistResponse[]): BulkRelistResponse {
  const results = parts.flatMap((p) => p.results);
  const succeeded = results.filter((r) => r.ok).length;
  return {
    ok: true,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    queued: results.filter((r) => r.ok && r.mode === "queued").length,
    results,
  };
}

export function useBulkRelist() {
  const qc = useQueryClient();
  return useMutation<BulkRelistResponse, Error & { status?: number }, { listingIds: string[] }>({
    mutationFn: async ({ listingIds }) => {
      const parts: BulkRelistResponse[] = [];
      for (const chunk of chunkForBulkRelist(listingIds)) {
        const res = await edgeFetch("/api/flipdesk/listings/bulk-relist", {
          method: "POST",
          json: { listing_ids: chunk },
        });
        const json = (await res.json().catch(() => ({}))) as Partial<BulkRelistResponse> & { error?: string };
        if (!res.ok || !json.results) {
          const err = new Error("Bulk relist failed.") as Error & { status?: number };
          err.status = res.status;
          throw err;
        }
        parts.push(json as BulkRelistResponse);
      }
      return mergeBulkRelistResponses(parts);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["items_full"] });
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
    },
  });
}
