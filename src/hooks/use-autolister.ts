import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import type { ListingGenerationJobStatus, ListingGenerationStatus } from "@/types/database";

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
