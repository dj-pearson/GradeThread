import { useCallback, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { supabase } from "@/lib/supabase";
import type {
  ListingGenerationJobStatus,
  ListingGenerationStatus,
  PhotoQaIssue,
} from "@/types/database";

// Client for the AutoLister batch API (US-313 backend). Submits grouped items
// for AI listing generation and polls per-item progress for the queue view
// (US-318).

export interface AutolisterBatch {
  id: string;
  status: ListingGenerationStatus;
  source: string;
  item_count: number;
  succeeded_count: number;
  failed_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutolisterJob {
  id: string;
  inventory_item_id: string;
  status: ListingGenerationJobStatus;
  error: string | null;
  attempts: number;
  listing_id: string | null;
  updated_at: string;
}

export interface BatchStatusResponse {
  batch: AutolisterBatch;
  jobs: AutolisterJob[];
}

interface StartBatchInput {
  item_ids: string[];
  use_comps?: boolean;
}

interface StartBatchResponse {
  batch_id: string;
  item_count: number;
}

/** POST /api/flipdesk/autolister/batch — enqueue items for generation. */
export function useStartAutolisterBatch() {
  return useMutation<StartBatchResponse, Error, StartBatchInput>({
    mutationFn: async (input) => {
      const res = await edgeFetch("/api/flipdesk/autolister/batch", {
        method: "POST",
        json: input,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not start generation.");
      }
      return json as StartBatchResponse;
    },
    onError: (err) => toast.error(err.message),
  });
}

// ── Bulk publish (US-321) ───────────────────────────────────────
//
// Client-side orchestrator over the proven single-item publish path: for each
// item it validates (POST /listings/validate — refuses items with unresolved
// blockers) then publishes (POST /listings/push — the 3-step inventory PUT →
// offer POST → offer publish). Runs with bounded concurrency, captures a
// per-item result, and writes the publish outcome back to the listing row
// (synced_to_ebay_at on success; publish_error/publish_failed_at on failure).

const PUBLISH_CONCURRENCY = 3;

// eBay returns 429 under burst publishing. Retry the publish call a few times
// with exponential backoff (full jitter) before giving up on an item (US-325).
const PUBLISH_RETRYABLE = new Set([429, 500, 502, 503, 504]);

function backoff(attempt: number): Promise<void> {
  const cap = Math.min(8000, 500 * 2 ** (attempt - 1));
  return new Promise((r) => setTimeout(r, Math.floor(Math.random() * cap)));
}

export type BulkPublishStatus = "pending" | "publishing" | "success" | "failed";

export interface BulkPublishItemResult {
  itemId: string;
  status: BulkPublishStatus;
  error?: string;
  listingUrl?: string;
}

export interface BulkPublishItem {
  itemId: string;
  listingId?: string | null;
}

async function markListingOutcome(
  item: BulkPublishItem,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    let q = supabase.from("listings").update(patch as never);
    q = item.listingId
      ? q.eq("id", item.listingId)
      : q.eq("inventory_item_id", item.itemId).eq("platform", "ebay");
    await q;
  } catch {
    /* non-fatal — the UI already reflects the result */
  }
}

export function useBulkPublish() {
  const [results, setResults] = useState<Record<string, BulkPublishItemResult>>({});
  const [running, setRunning] = useState(false);

  const set = useCallback((itemId: string, patch: Partial<BulkPublishItemResult>) => {
    setResults((prev) => ({
      ...prev,
      [itemId]: { ...(prev[itemId] ?? { itemId, status: "pending" }), ...patch, itemId },
    }));
  }, []);

  const run = useCallback(
    async (items: BulkPublishItem[]) => {
      if (items.length === 0) return;
      setRunning(true);
      setResults(
        Object.fromEntries(
          items.map((i) => [i.itemId, { itemId: i.itemId, status: "pending" as const }]),
        ),
      );

      let failed = 0;
      const publishOne = async (item: BulkPublishItem) => {
        set(item.itemId, { status: "publishing" });
        try {
          // Pre-flight: refuse items with unresolved blockers.
          const vRes = await edgeFetch("/api/flipdesk/ebay/listings/validate", {
            method: "POST",
            json: { inventory_item_id: item.itemId },
          });
          const vJson = await vRes.json().catch(() => ({}));
          if (!vRes.ok) throw new Error(vJson.error || "Validation failed.");
          if (vJson.ok === false && Array.isArray(vJson.blockers) && vJson.blockers.length) {
            throw new Error(vJson.blockers.join(" • "));
          }

          // Publish (3-step Sell API flow on the server), retrying transient
          // rate-limit / 5xx responses with exponential backoff.
          const MAX_PUBLISH_ATTEMPTS = 3;
          let pRes: Response | null = null;
          let pJson: Record<string, unknown> = {};
          for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
            pRes = await edgeFetch("/api/flipdesk/ebay/listings/push", {
              method: "POST",
              json: { inventory_item_id: item.itemId },
            });
            pJson = await pRes.json().catch(() => ({}));
            if (
              PUBLISH_RETRYABLE.has(pRes.status) &&
              attempt < MAX_PUBLISH_ATTEMPTS
            ) {
              await backoff(attempt);
              continue;
            }
            break;
          }
          if (!pRes || !pRes.ok || pJson.ok === false) {
            const detail = (pJson.detail ?? pJson.error ?? "Publish failed.") as string;
            const blockers = Array.isArray(pJson.blockers)
              ? (pJson.blockers as string[]).join(" • ")
              : "";
            throw new Error(blockers ? `${detail} — ${blockers}` : detail);
          }

          set(item.itemId, {
            status: "success",
            listingUrl:
              typeof pJson.listing_url === "string" ? pJson.listing_url : undefined,
          });
          await markListingOutcome(item, {
            synced_to_ebay_at: new Date().toISOString(),
            publish_error: null,
            publish_failed_at: null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Publish failed.";
          failed++;
          set(item.itemId, { status: "failed", error: message });
          await markListingOutcome(item, {
            publish_error: message,
            publish_failed_at: new Date().toISOString(),
          });
        }
      };

      for (let i = 0; i < items.length; i += PUBLISH_CONCURRENCY) {
        await Promise.all(items.slice(i, i + PUBLISH_CONCURRENCY).map(publishOne));
      }
      setRunning(false);

      toast.success(
        `Publish finished — ${items.length - failed} live${failed ? `, ${failed} failed` : ""}.`,
      );
    },
    [set],
  );

  return { run, results, running };
}

// ── Photo QA (US-537) ───────────────────────────────────────────
export interface PhotoQaItemResult {
  item_id: string;
  score: number; // 0-100, or -1 when the QA pass errored for that item
  issues: PhotoQaIssue[];
  error?: string;
}

/**
 * POST /api/flipdesk/autolister/photo-qa — score the given items' photos for
 * listing-readiness and persist the score + issues on each item.
 */
export function useRunPhotoQa() {
  return useMutation<{ results: PhotoQaItemResult[] }, Error, { itemIds: string[] }>({
    mutationFn: async ({ itemIds }) => {
      const res = await edgeFetch("/api/flipdesk/autolister/photo-qa", {
        method: "POST",
        json: { item_ids: itemIds },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not check photos.");
      return json as { results: PhotoQaItemResult[] };
    },
    onError: (err) => toast.error(err.message),
  });
}

/**
 * GET /api/flipdesk/autolister/batch/:id — poll batch + per-job status.
 * Auto-refetches every 1.5s while the batch is still running.
 */
export function useAutolisterBatch(batchId: string | null) {
  return useQuery<BatchStatusResponse>({
    queryKey: ["autolister_batch", batchId],
    enabled: !!batchId,
    refetchInterval: (query) => {
      const status = query.state.data?.batch.status;
      return status === "pending" || status === "running" ? 1500 : false;
    },
    queryFn: async () => {
      const res = await edgeFetch(`/api/flipdesk/autolister/batch/${batchId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load batch.");
      return json as BatchStatusResponse;
    },
  });
}

/**
 * POST /api/flipdesk/autolister/batch/:id/retry-failed — re-runs only the
 * failed jobs in this batch in place, incrementing each job's attempts. The
 * queue keeps polling the same batch_id; no navigation needed.
 */
export function useRetryFailedAutolister() {
  return useMutation<{ batch_id: string; retried: number }, Error, { batchId: string }>({
    mutationFn: async ({ batchId }) => {
      const res = await edgeFetch(
        `/api/flipdesk/autolister/batch/${batchId}/retry-failed`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not retry failed jobs.");
      return json as { batch_id: string; retried: number };
    },
    onError: (err) => toast.error(err.message),
  });
}
