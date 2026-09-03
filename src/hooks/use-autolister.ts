import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import { MAX_QA_ITEMS, runChunkedQa } from "@/lib/photo-qa-chunking";
import { fetchCapped } from "@/lib/paged-read";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type {
  AspectReviewEntry,
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
  // US-955: auto-publish the green (high-confidence), pre-flight-clean drafts
  // when generation finishes — fire-and-forget. Defaults off server-side.
  auto_publish_green?: boolean;
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
    onError: (err) => toastError(err),
  });
}

// ── Bulk publish (US-321, durable in US-559) ────────────────────────
//
// Bulk publish is a DURABLE, SERVER-SIDE batch (US-559): the browser POSTs the
// item set to /autolister/publish-batch (which validates + publishes each item
// with central bounded concurrency, idempotent per item) and then POLLS the
// batch for per-item status. The run survives a tab close — the work continues
// server-side and the reclaim sweeper resumes it across a container restart —
// and the eBay rate budget is centralized in the one server worker instead of
// being multiplied across browser tabs each looping /push.
//
// The hook keeps its original { run, results, running } surface so the drafts
// cockpit is unchanged; results are derived from the polled jobs.

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

// Server job → UI result status. The jobs table uses the same lifecycle as
// generation jobs (pending → running → success/failed).
function jobToStatus(jobStatus: string): BulkPublishStatus {
  switch (jobStatus) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "running":
      return "publishing";
    default:
      return "pending";
  }
}

interface PublishJobRow {
  inventory_item_id: string;
  status: string;
  error: string | null;
  listing_url: string | null;
}

export function useBulkPublish() {
  const [results, setResults] = useState<Record<string, BulkPublishItemResult>>({});
  const [running, setRunning] = useState(false);
  // US-1633: stop the poll loop when the component unmounts (the durable server
  // batch keeps going regardless) so it doesn't run forever / setState after
  // unmount. Also a hard poll cap so a stuck batch can't spin indefinitely.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const run = useCallback(async (items: BulkPublishItem[]) => {
    if (items.length === 0) return;
    setRunning(true);
    setResults(
      Object.fromEntries(
        items.map((i) => [i.itemId, { itemId: i.itemId, status: "pending" as const }]),
      ),
    );

    const finish = (failed: number, total: number) => {
      setRunning(false);
      toast.success(
        `Publish finished — ${total - failed} live${failed ? `, ${failed} failed` : ""}.`,
      );
    };

    const failAll = (message: string) => {
      setResults((prev) =>
        Object.fromEntries(
          Object.values(prev).map((r) => [r.itemId, { ...r, status: "failed", error: message }]),
        ),
      );
      setRunning(false);
      toast.error(message);
    };

    // 1. Start the durable server batch.
    let batchId: string;
    try {
      const res = await edgeFetch("/api/flipdesk/autolister/publish-batch", {
        method: "POST",
        json: { item_ids: items.map((i) => i.itemId) },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.batch_id) {
        failAll(json.error || "Could not start publishing.");
        return;
      }
      batchId = json.batch_id as string;
    } catch (err) {
      failAll(err instanceof Error ? err.message : "Could not start publishing.");
      return;
    }

    // 2. Poll the batch until it terminalizes, mapping jobs → per-item results.
    //    Closing the tab here doesn't stop the publish — the server owns it.
    //    US-1633: bounded (~20 min at 1.5s) and unmount-cancellable.
    const MAX_POLLS = 800;
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (cancelledRef.current) return; // unmounted — stop touching state
      let json: {
        batch?: { status?: string };
        jobs?: PublishJobRow[];
      };
      try {
        const res = await edgeFetch(`/api/flipdesk/autolister/publish-batch/${batchId}`);
        json = await res.json().catch(() => ({}));
        if (!res.ok) continue; // transient — keep polling
      } catch {
        continue;
      }
      if (cancelledRef.current) return;

      const jobs = json.jobs ?? [];
      setResults(() =>
        Object.fromEntries(
          jobs.map((j) => [
            j.inventory_item_id,
            {
              itemId: j.inventory_item_id,
              status: jobToStatus(j.status),
              error: j.error ?? undefined,
              listingUrl: j.listing_url ?? undefined,
            } satisfies BulkPublishItemResult,
          ]),
        ),
      );

      const status = json.batch?.status;
      if (status && status !== "pending" && status !== "running") {
        const failed = jobs.filter((j) => j.status === "failed").length;
        finish(failed, jobs.length || items.length);
        return;
      }
    }
    // US-1633: hit the poll cap without terminalizing — the durable server batch
    // is still running; stop the local spinner and tell the user it'll finish
    // server-side rather than polling forever.
    if (!cancelledRef.current) {
      setRunning(false);
      toast.info(
        "Publishing is taking longer than expected — it will finish on the server. Refresh later to see the results.",
      );
    }
  }, []);

  return { run, results, running };
}

// ── Photo QA (US-537) ───────────────────────────────────────────
export interface PhotoQaItemResult {
  item_id: string;
  score: number; // 0-100, or -1 when the QA pass errored for that item
  issues: PhotoQaIssue[];
  error?: string;
}

// US-957: pre-generation cover scan. Scores each group's cover photo by its
// staged storage_path BEFORE any inventory item exists, so an unusable cover can
// be reshot before AI generation quota is spent. Reuses the same /photo-qa
// endpoint (and the same vision lib) — the `covers` body shape returns scores
// without persisting (there's no item row yet).
export interface CoverQaResult {
  cover_id: string;
  score: number; // 0-100, or -1 when the QA pass errored for that cover
  issues: PhotoQaIssue[];
  error?: string;
}

export interface CoverQaInput {
  id: string;
  storage_path: string;
}

export interface RunCoverQaResult {
  /** Scores merged across every chunk whose request succeeded. */
  results: CoverQaResult[];
  /** Covers whose chunk failed at the request level — left unscored so a later
   *  intake pass retries them. */
  failed: CoverQaInput[];
}

async function fetchCoverQaChunk(batch: CoverQaInput[]): Promise<CoverQaResult[]> {
  const res = await edgeFetch("/api/flipdesk/autolister/photo-qa", {
    method: "POST",
    json: { covers: batch },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Could not check photos.");
  return (json as { results: CoverQaResult[] }).results ?? [];
}

export function useRunCoverQa() {
  return useMutation<
    RunCoverQaResult,
    Error,
    { covers: CoverQaInput[]; onPartial?: (chunkResults: CoverQaResult[]) => void }
  >({
    // US-1911: chunk to the server's ≤100-per-request cap (MAX_BATCH_ITEMS is
    // 300, so a big session exceeds it) and issue chunks sequentially, merging
    // partials as each resolves. Advisory only: never rejects — a failed chunk
    // poisons only itself and its covers are returned in `failed` so the intake
    // flow can retry them without interrupting grouping or blocking Generate.
    mutationFn: async ({ covers, onPartial }) =>
      runChunkedQa(covers, fetchCoverQaChunk, {
        maxPerRequest: MAX_QA_ITEMS,
        onPartial,
      }),
  });
}

export interface RunPhotoQaResult {
  /** Per-item scores merged across every chunk whose request succeeded. An
   *  individual entry may still carry score -1 for a per-item QA error. */
  results: PhotoQaItemResult[];
  /** Total items requested (so the caller can report "Scored X of Y"). */
  requested: number;
  /** Ids in chunks that failed at the request level — never scored, so a later
   *  pass can retry them. */
  failedItemIds: string[];
}

async function fetchPhotoQaChunk(batch: string[]): Promise<PhotoQaItemResult[]> {
  const res = await edgeFetch("/api/flipdesk/autolister/photo-qa", {
    method: "POST",
    json: { item_ids: batch },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Could not check photos.");
  return (json as { results: PhotoQaItemResult[] }).results ?? [];
}

/**
 * POST /api/flipdesk/autolister/photo-qa — score the given items' photos for
 * listing-readiness and persist the score + issues on each item.
 *
 * US-1911: chunks to the server's ≤100-per-request cap and issues chunks
 * sequentially. A failed chunk no longer poisons the rest — its items surface
 * in `failedItemIds` and the successful chunks still score, so the caller can
 * report an honest "Scored X of Y". Only a total wipeout (nothing scored)
 * rejects, preserving the single-item add-photos flow's error toast.
 */
export function useRunPhotoQa() {
  return useMutation<
    RunPhotoQaResult,
    Error,
    { itemIds: string[]; onPartial?: (chunkResults: PhotoQaItemResult[]) => void }
  >({
    mutationFn: async ({ itemIds, onPartial }) => {
      let lastError: Error | null = null;
      const { results, failed } = await runChunkedQa(itemIds, fetchPhotoQaChunk, {
        maxPerRequest: MAX_QA_ITEMS,
        onPartial,
        onChunkError: (err) => {
          lastError = err instanceof Error ? err : new Error("Could not check photos.");
        },
      });
      // Only a total wipeout is an error toast; any partial success resolves so
      // the caller can report an honest "Scored X of Y".
      if (results.length === 0 && failed.length > 0) {
        throw lastError ?? new Error("Could not check photos.");
      }
      return { results, requested: itemIds.length, failedItemIds: failed };
    },
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
  });
}

// Resumes a STRANDED batch (jobs stuck 'pending'/'running' because the
// background worker was interrupted). Lets the seller unstick a 0/N batch
// immediately instead of waiting on the reclaim cron.
export function useResumeAutolister() {
  return useMutation<{ batch_id: string; resumed: number }, Error, { batchId: string }>({
    mutationFn: async ({ batchId }) => {
      const res = await edgeFetch(
        `/api/flipdesk/autolister/batch/${batchId}/resume`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not resume generation.");
      return json as { batch_id: string; resumed: number };
    },
    onError: (err) => toastError(err),
  });
}

// ── US-721/US-723: per-marketplace listing fields ───────────────────────

export interface PlatformKitVariant {
  platform: string;
  title: string;
  description: string;
  condition: { value: string; label: string } | null;
  category: string;
  // US-722 category provenance: where the mapped category came from, an optional
  // department/gender to confirm, and whether the seller must pick a category.
  categorySource?: "seed" | "ai" | "admin" | "query" | null;
  categoryDepartment?: string | null;
  categoryNeedsPick?: boolean;
  brand: string | null;
  color: string | null;
  size: string | null;
  /** The eBay Style specific, shown in Depop's style field (2026-09-02). */
  style?: string | null;
  /** True when the AutoLister batch filled this variant with the draft. */
  generatedWithDraft?: boolean;
  price: number;
  tags: string[];
  confidence: number;
  validation: {
    platform: string;
    ok: boolean;
    issues: { field: string; level: "error" | "warning"; message: string }[];
  };
}

/**
 * POST /api/flipdesk/autolister/platform-fields — AI-generate (and persist)
 * tailored listing fields for the requested non-eBay marketplaces, so the
 * copy-paste Listing Kit (US-723) has ready content. Returns the variants;
 * the server also writes them to listings.platform_fields.
 */
export function useGeneratePlatformFields() {
  return useMutation<
    { listing_id: string; variants: PlatformKitVariant[] },
    Error,
    { itemId: string; platforms: string[] }
  >({
    mutationFn: async ({ itemId, platforms }) => {
      const res = await edgeFetch("/api/flipdesk/autolister/platform-fields", {
        method: "POST",
        json: { item_id: itemId, platforms },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not generate marketplace fields.");
      }
      return json as { listing_id: string; variants: PlatformKitVariant[] };
    },
    onError: (err) => toastError(err),
  });
}

// ── Inventory reconciliation (sheet record ⇄ AI draft) ──────────────────
// When an AutoLister photo group was bound to an existing inventory item by
// SKU, the AI-generated draft can be reconciled field-by-field against the
// seller's imported record. Shared edge endpoints power web + iOS identically.

export interface ReconcileFieldDiff {
  key: string;
  label: string;
  original: string;
  ai: string;
  differs: boolean;
  suggested: "original" | "ai";
}

export interface ReconcileDiffResponse {
  inventory_item_id: string;
  sku: string | null;
  has_original: boolean;
  conflicts: number;
  fields: ReconcileFieldDiff[];
}

// Lazy: fetches the field diff for one item. Pass enabled=false until the
// reconcile panel is opened so a big batch doesn't fire N calls eagerly.
export function useReconcileDiff(itemId: string, enabled: boolean) {
  return useQuery<ReconcileDiffResponse, Error>({
    queryKey: ["autolister_reconcile_diff", itemId],
    enabled: enabled && !!itemId,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await edgeFetch("/api/flipdesk/autolister/reconcile/diff", {
        method: "POST",
        json: { inventory_item_id: itemId },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load comparison.");
      return json as ReconcileDiffResponse;
    },
  });
}

export function useApplyReconcile() {
  return useMutation<
    { ok: true; inventory_item_id: string },
    Error,
    { itemId: string; choices: Record<string, "original" | "ai"> }
  >({
    mutationFn: async ({ itemId, choices }) => {
      const res = await edgeFetch("/api/flipdesk/autolister/reconcile/apply", {
        method: "POST",
        json: { inventory_item_id: itemId, choices },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not save your picks.");
      return json as { ok: true; inventory_item_id: string };
    },
    onError: (err) => toastError(err),
  });
}

// After-the-fact binding: ties an already-created AutoLister item (just photos +
// AI draft) to an EXISTING inventory item by the seller's SKU, moving the photos
// + draft onto it and archiving the source. Solves the "I uploaded first, now I
// want to attach it to my existing #695" case (retyping the SKU 409s on the
// unique constraint). Returns the target item id to reconcile against.
export function useLinkToExisting() {
  return useMutation<
    { ok: true; target_item_id: string },
    Error,
    { sourceItemId: string; targetSku: string }
  >({
    mutationFn: async ({ sourceItemId, targetSku }) => {
      const res = await edgeFetch("/api/flipdesk/autolister/reconcile/link", {
        method: "POST",
        json: { source_item_id: sourceItemId, target_sku: targetSku },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not link to that SKU.");
      return json as { ok: true; target_item_id: string };
    },
    onError: (err) => toastError(err),
  });
}

// ── US-2374: phone → desktop handoff ────────────────────────────────
//
// A batch shot on the phone parks its staged photos + grouping server-side
// (POST /autolister/sessions from the mobile app). These hooks are the desktop
// half: what's waiting, load one into this page's session, claim it so it stops
// being offered, or discard it (which also sweeps its staged objects).

export interface AutolisterHandoffSummary {
  id: string;
  source: "ios" | "android" | "web";
  status: "open" | "claimed";
  photo_count: number;
  group_count: number;
  created_at: string;
}

export interface AutolisterHandoffPhoto {
  id: string;
  storage_path: string;
  url: string;
  thumbnail_storage_path: string | null;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  captured_at_ms: number | null;
  source_name: string | null;
  phash: string;
}

export interface AutolisterHandoffSession extends AutolisterHandoffSummary {
  staging_session_id: string;
  photos: AutolisterHandoffPhoto[];
  groups: Array<{ id: string; photo_ids: string[]; cover_id: string }>;
}

/** GET /api/flipdesk/autolister/sessions — batches waiting from a phone. */
export function useAutolisterHandoffs(enabled = true) {
  return useQuery<AutolisterHandoffSummary[]>({
    queryKey: ["autolister_handoffs"],
    enabled,
    // Polled, not pushed: the seller is expected to walk from the phone to the
    // desk, so the card should already be there when they sit down.
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await edgeFetch("/api/flipdesk/autolister/sessions");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load waiting batches.");
      return (json.sessions ?? []) as AutolisterHandoffSummary[];
    },
  });
}

/** GET one handoff's full payload. */
export async function fetchAutolisterHandoff(
  id: string,
): Promise<AutolisterHandoffSession> {
  const res = await edgeFetch(`/api/flipdesk/autolister/sessions/${id}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Could not load that batch.");
  return json as AutolisterHandoffSession;
}

/** Mark a handoff loaded. Kept server-side, not deleted — see the route. */
export function useClaimAutolisterHandoff() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: async (id) => {
      const res = await edgeFetch(`/api/flipdesk/autolister/sessions/${id}/claim`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not claim that batch.");
      return json as { ok: true };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["autolister_handoffs"] }),
  });
}

/** Discard a handoff and its staged photos. */
export function useDiscardAutolisterHandoff() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: async (id) => {
      const res = await edgeFetch(`/api/flipdesk/autolister/sessions/${id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not discard that batch.");
      return json as { ok: true };
    },
    onError: (err) => toastError(err),
    onSettled: () => qc.invalidateQueries({ queryKey: ["autolister_handoffs"] }),
  });
}

// -- The drafts cockpit's read (US-3077 AC6) --------------------------------
//
// Lifted out of src/pages/flipdesk/autolister-drafts.tsx unchanged: same query
// key, same columns, same filters, same cap. The page still renders the
// cockpit; it just no longer owns the read, so the overview widget counts the
// SAME rows rather than a second query that could drift apart from it. A widget
// saying 12 beside a page saying 9 is worse than no widget.

/** One unpublished, unreviewed AutoLister draft. */
export interface AutolisterDraftRow {
  id: string;
  inventory_item_id: string;
  listing_title: string | null;
  listing_price: number | null;
  batch_id: string | null;
  created_at: string;
  scheduled_publish_at: string | null;
  price_is_estimated: boolean | null;
  price_comp_source: string | null;
  platform_category_id: string | null;
  needs_review: boolean | null;
  // US-828: per-aspect needs-review entries from generation reconciliation; its
  // length drives the "N to fix" count badge on the row.
  aspect_review: AspectReviewEntry[] | null;
}

/**
 * Every AutoLister draft waiting on a human.
 *
 * US-2169: capped reads report their own truncation. `.limit(500)` rendered as
 * if it were everything meant a seller past 500 drafts published against a
 * queue they could not tell was cut short. fetchCapped asks for one row past
 * the cap, so `truncated` is a fact rather than a guess.
 *
 * US-2867: the queryFn THROWS on a PostgREST error rather than returning [],
 * so a caller's `?? []` fallback cannot render "no drafts yet" during an
 * outage. An empty state is a claim about the data, and a failed read has no
 * data to make claims about.
 */
export function useAutolisterDrafts(enabled = true) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["autolister_drafts", user?.id],
    enabled: enabled && !!user,
    staleTime: 30_000,
    queryFn: () =>
      fetchCapped<AutolisterDraftRow>(async (limit) => {
        const { data, error } = await supabase
          .from("listings")
          .select(
            "id, inventory_item_id, listing_title, listing_price, batch_id, created_at, scheduled_publish_at, price_is_estimated, price_comp_source, platform_category_id, needs_review, aspect_review",
          )
          .eq("listing_status", "draft")
          .not("batch_id", "is", null)
          // US-1568: this cockpit is the 'AI-processed, not yet human-reviewed'
          // queue. A composer Save stamps reviewed_at and the draft drops off
          // here; its durable home is Inventory > Drafts until published.
          .is("reviewed_at", null)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data ?? []) as AutolisterDraftRow[];
      }),
  });
}
