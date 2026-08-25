import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { BatchNav } from "./autolister/batch-nav";
import {
  MeasurementsBadge,
  PhotoQaBadge,
  PreflightBadge,
  PublishConfirmDialog,
  type PreflightItem,
} from "./autolister/queue-cells";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  XCircle,
  Clock,
  RefreshCw,
  ArrowRight,
  Rocket,
  ExternalLink,
  AlertTriangle,
  Camera,
  ImagePlus,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { runWithConcurrency } from "@/lib/concurrency";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useAutolisterBatch,
  useBulkPublish,
  useResumeAutolister,
  useRetryFailedAutolister,
  useRunPhotoQa,
  type AutolisterJob,
} from "@/hooks/use-autolister";
import { useEbayConnection } from "@/hooks/use-ebay";
import { ReconcilePanel } from "@/components/flipdesk/reconcile-panel";
import { VirtualList } from "@/components/flipdesk/virtual-list";
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import type { ItemCategory, ItemStatus, PhotoQaIssue } from "@/types/database";
import { cn } from "@/lib/utils";
import { FilterEmpty } from "@/components/flipdesk/filter-empty";

// AutoLister queue / progress view (US-318). Polls the batch until it finishes,
// shows per-item status, links completed drafts to the editor, and lets the
// user re-run only the failed items.

function StatusIcon({ status }: { status: AutolisterJob["status"] }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}


// US-1559: minimum spacing between /listings/validate request STARTS. The edge
// rate-limits /ebay/listings/* at 30/min; ~24 starts/min leaves headroom for
// the user's own clicks. Shared (via a ref) by the background pre-flight wave
// and the publish dialog so they can't stack into a 429 storm together.
const VALIDATE_SPACING_MS = 2500;
async function acquireValidateSlot(slotRef: { current: number }): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, slotRef.current);
  slotRef.current = startAt + VALIDATE_SPACING_MS;
  if (startAt > now) {
    await new Promise((resolve) => setTimeout(resolve, startAt - now));
  }
}

const RUNNING_SUBTITLE =
  "AI is generating your listings — this page updates automatically.";

export function FlipdeskAutolisterQueuePage() {
  const [params] = useSearchParams();
  const batchId = params.get("batch");
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useAutolisterBatch(batchId);
  const retryFailedMutation = useRetryFailedAutolister();
  const resumeMutation = useResumeAutolister();
  const bulkPublish = useBulkPublish();
  const { data: ebayConnection } = useEbayConnection();

  // US-321 confirmation dialog state.
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [preflight, setPreflight] = useState<PreflightItem[]>([]);
  const [preflightLoading, setPreflightLoading] = useState(false);
  // US-954: background pre-flight cache keyed by inventory_item_id. Each
  // succeeded draft is validated against eBay as it lands, so a per-row
  // ready / will-block badge shows before the seller opens the publish dialog —
  // and the dialog reuses these results instead of re-validating from scratch.
  const [preflightByItem, setPreflightByItem] = useState<
    Record<string, { blockers: string[]; loaded: boolean }>
  >({});
  // itemIds already validated or in-flight, so the polling effect never
  // re-fires a validate for the same draft.
  const preflightSeenRef = useRef<Set<string>>(new Set());
  // US-1559: global pacing for the pre-flight wave. The edge rate-limits
  // /ebay/listings/* at 30/min; a 44-draft batch validated at concurrency 4
  // with no spacing blew straight through it (a sustained 429 storm, because
  // every 429 re-armed the id and the next poll re-fired it). validateSlotRef
  // spaces request STARTS globally (across overlapping effect runs), and
  // preflightCooldownRef pauses the whole wave after any 429.
  const validateSlotRef = useRef(0);
  const preflightCooldownRef = useRef(0);
  // US-554: queue filter/sort + multi-select.
  const [queueFilter, setQueueFilter] = useState<"all" | "ready" | "review" | "failed">("all");
  const [queueSort, setQueueSort] = useState<"confidence" | "price" | "status">("confidence");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Add-photos dialog: the draft whose photos are being edited in place (fixes a
  // missing required photo without leaving the cockpit), plus whether the set
  // actually changed while it was open (so we only re-score QA when it did).
  const [photoItem, setPhotoItem] = useState<
    { id: string; title: string; category: ItemCategory | null; status: ItemStatus | null } | null
  >(null);
  const photosDirtyRef = useRef(false);

  const runPhotoQa = useRunPhotoQa();

  const jobs = useMemo(() => data?.jobs ?? [], [data]);
  const itemIds = useMemo(() => jobs.map((j) => j.inventory_item_id), [jobs]);
  // Key on the id CONTENTS, not the count: a length-only key returns the stale
  // meta map when the batch's id set changes without changing size.
  const itemIdsKey = useMemo(() => [...itemIds].sort().join(","), [itemIds]);

  // Item titles + persisted photo-QA (US-537) for friendlier, actionable rows.
  interface ItemMeta {
    title: string;
    qaScore: number | null;
    qaIssues: PhotoQaIssue[];
    /** US-1578: informational — the item carries flat measurements. */
    hasMeasurements: boolean;
    /** Feed the in-cockpit "Add photos" uploader the right slot profile + status. */
    category: ItemCategory | null;
    status: ItemStatus | null;
  }
  const { data: itemMeta = {} } = useQuery<Record<string, ItemMeta>>({
    queryKey: ["autolister_item_meta", batchId, itemIdsKey],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      // US-554: chunk so large batches don't overflow the `in` list.
      const CHUNK = 200;
      const map: Record<string, ItemMeta> = {};
      for (let i = 0; i < itemIds.length; i += CHUNK) {
        const { data: rows } = await supabase
          .from("inventory_items")
          .select("id, title, photo_qa_score, photo_qa_issues, measurements, item_category, status")
          .in("id", itemIds.slice(i, i + CHUNK));
        for (
          const r of (rows ?? []) as Array<{
            id: string;
            title: string;
            photo_qa_score: number | null;
            photo_qa_issues: PhotoQaIssue[] | null;
            measurements: Record<string, unknown> | null;
            item_category: ItemCategory | null; // US-2804: was `category`
            status: ItemStatus | null;
          }>
        ) {
          map[r.id] = {
            title: r.title,
            qaScore: r.photo_qa_score,
            qaIssues: r.photo_qa_issues ?? [],
            hasMeasurements: !!r.measurements &&
              Object.keys(r.measurements).length > 0,
            category: r.item_category ?? null,
            status: r.status ?? null,
          };
        }
      }
      return map;
    },
  });
  // Position in the batch, so an untitled row reads "Generation 3" rather than
  // leaking a raw inventory_item_id. Keyed off the FULL job list (not the
  // filtered view) so the number stays stable as the user filters.
  const ordinalOf = useMemo(() => {
    const map: Record<string, number> = {};
    jobs.forEach((j, i) => {
      map[j.inventory_item_id] = i + 1;
    });
    return map;
  }, [jobs]);
  // Titles arrive from a separate query and are null until the AI names the
  // draft, so this fallback is the common case while a batch is still running.
  const titleOf = (id: string): string => {
    const title = itemMeta[id]?.title?.trim();
    if (title) return title;
    const n = ordinalOf[id];
    return n ? `Generation ${n}` : "Generation";
  };

  // US-541: which generated drafts the AI flagged as needing a human look, plus
  // the specific low-confidence fields (for the badge tooltip). Keyed by
  // listing_id; RLS scopes the read to the owner via the parent item.
  const listingIds = useMemo(
    () => jobs.map((j) => j.listing_id).filter((id): id is string => !!id),
    [jobs],
  );
  // Content key, not count — see itemIdsKey above.
  const listingIdsKey = useMemo(() => [...listingIds].sort().join(","), [listingIds]);
  const { data: reviewByListing = {} } = useQuery<
    Record<string, { needsReview: boolean; fields: string[]; price: number | null }>
  >({
    queryKey: ["autolister_listing_review", batchId, listingIdsKey],
    enabled: listingIds.length > 0,
    queryFn: async () => {
      // US-554: chunk the id list so a very large batch can't blow the URL/`in`
      // length limit (was a single unbounded .in()).
      const CHUNK = 200;
      const map: Record<
        string,
        { needsReview: boolean; fields: string[]; price: number | null }
      > = {};
      for (let i = 0; i < listingIds.length; i += CHUNK) {
        const { data: rows } = await supabase
          .from("listings")
          .select("id, needs_review, ai_field_confidence, listing_price")
          .in("id", listingIds.slice(i, i + CHUNK));
        for (
          const r of (rows ?? []) as Array<{
            id: string;
            needs_review: boolean | null;
            ai_field_confidence: Record<string, number> | null;
            listing_price: number | null;
          }>
        ) {
          const low = r.ai_field_confidence
            ? Object.entries(r.ai_field_confidence)
              // US-956: listing_price confidence rides in ai_field_confidence to
              // gate the "est." badge — it's not an item-specific aspect, so keep
              // it out of the "AI is unsure about: …" aspect tooltip.
              .filter(([name, c]) => name !== "listing_price" && c < 0.7)
              .map(([name]) => name)
            : [];
          map[r.id] = {
            needsReview: !!r.needs_review,
            fields: low,
            price: r.listing_price,
          };
        }
      }
      return map;
    },
  });

  // Notify once when the generation batch finishes (US-325 AC4).
  const notifiedRef = useRef<string | null>(null);
  const batchStatus = data?.batch.status;
  useEffect(() => {
    if (!data || !batchId) return;
    const terminal = batchStatus === "completed" || batchStatus === "partial" ||
      batchStatus === "failed";
    if (!terminal || notifiedRef.current === batchId) return;
    notifiedRef.current = batchId;
    const { succeeded_count: ok, failed_count: bad } = data.batch;
    if (bad === 0) {
      toast.success(`Generated ${ok} listing${ok === 1 ? "" : "s"}.`);
    } else {
      toast.warning(`Generation finished — ${ok} ready, ${bad} failed.`, {
        description: "Use “Retry failed” to re-run the ones that didn't generate.",
      });
    }
  }, [data, batchId, batchStatus]);

  // US-954: background pre-flight. As each draft finishes generating, validate
  // it against eBay (category, required aspects, price range, policies) with
  // bounded concurrency so we respect eBay's rate budget. Results warm
  // `preflightByItem`, driving the per-row badge and seeding the publish dialog.
  // Skipped until eBay is connected (validate needs a live connection).
  useEffect(() => {
    if (!ebayConnection) return;
    // US-1559: after a 429, pause the whole wave — hammering the limiter just
    // extends the block. The publish dialog still validates on demand.
    if (Date.now() < preflightCooldownRef.current) return;
    const succeeded = jobs
      .filter((j) => j.status === "success")
      .map((j) => j.inventory_item_id);
    const pending = succeeded.filter((id) => !preflightSeenRef.current.has(id));
    if (pending.length === 0) return;
    pending.forEach((id) => preflightSeenRef.current.add(id));

    let cancelled = false;
    void runWithConcurrency(pending, 2, async (itemId) => {
      if (cancelled) return;
      await acquireValidateSlot(validateSlotRef);
      if (cancelled || Date.now() < preflightCooldownRef.current) {
        preflightSeenRef.current.delete(itemId);
        return;
      }
      try {
        const res = await edgeFetch("/api/flipdesk/ebay/listings/validate", {
          method: "POST",
          json: { inventory_item_id: itemId },
        });
        if (res.status === 429) {
          // Rate-limited: re-arm this id and cool the wave down for a minute.
          preflightSeenRef.current.delete(itemId);
          preflightCooldownRef.current = Date.now() + 60_000;
          return;
        }
        if (!res.ok) {
          // Server/eBay error: never cache a false "ready" — re-arm instead.
          preflightSeenRef.current.delete(itemId);
          return;
        }
        const json = await res.json().catch(() => ({}));
        const blockers = Array.isArray(json.blockers)
          ? (json.blockers as string[])
          : [];
        if (cancelled) return;
        setPreflightByItem((prev) => ({
          ...prev,
          [itemId]: { blockers, loaded: true },
        }));
      } catch {
        // Transient failure: don't cache a false "ready". Re-arm so a later
        // poll re-validates, and let the publish dialog validate it on demand.
        preflightSeenRef.current.delete(itemId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [jobs, ebayConnection]);

  if (!batchId) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No batch specified.{" "}
        <Link to="/dashboard/flipdesk/autolister" className="text-primary underline">
          Start a new batch
        </Link>
        .
      </div>
    );
  }

  if (isLoading) {
    return (
      <LoadingRegion label="Loading batch" className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </LoadingRegion>
    );
  }

  if (error || !data) {
    return (
      <div className="py-12 text-center text-sm text-destructive">
        {error instanceof Error ? error.message : "Could not load this batch."}
      </div>
    );
  }

  const { batch } = data;
  const done = batch.succeeded_count + batch.failed_count;
  const pct = batch.item_count > 0 ? Math.round((done / batch.item_count) * 100) : 0;
  const isRunning = batch.status === "pending" || batch.status === "running";
  const failedItemIds = jobs
    .filter((j) => j.status === "failed")
    .map((j) => j.inventory_item_id);
  const succeededJobs = jobs.filter((j) => j.status === "success");
  // Jobs that never finished — if these sit unchanged, the background worker was
  // interrupted (container restart). The "Resume generation" button re-runs them.
  const pendingCount = jobs.filter(
    (j) => j.status === "pending" || j.status === "running",
  ).length;

  // US-550: confidence-based triage. Classify each draft green/amber/red from
  // the per-field AI confidence (US-541 needs_review) + the photo-QA score
  // (US-537), so a seller can accept the high-confidence ones in one click and
  // focus review on the rest. (Hard eBay blockers are still caught by the
  // /listings/validate pre-flight at publish time, so "green" = AI-confident.)
  type Tier = "green" | "amber" | "red";
  function tierOf(job: AutolisterJob): Tier {
    if (job.status === "failed") return "red";
    const review = job.listing_id ? reviewByListing[job.listing_id] : undefined;
    const qa = itemMeta[job.inventory_item_id]?.qaScore ?? null;
    const lowQa = qa != null && qa < 80;
    if (review?.needsReview || lowQa) return "amber";
    return "green";
  }
  const greenJobs = succeededJobs.filter((j) => tierOf(j) === "green");
  const amberCount = succeededJobs.length - greenJobs.length;
  const redCount = jobs.filter((j) => j.status === "failed").length;

  // US-554: filter + sort + multi-select for large batches.
  function priceOf(job: AutolisterJob): number | null {
    return job.listing_id ? reviewByListing[job.listing_id]?.price ?? null : null;
  }
  const matchesFilter = (job: AutolisterJob): boolean => {
    switch (queueFilter) {
      case "ready":
        return job.status === "success" && tierOf(job) === "green";
      case "review":
        return job.status === "success" && tierOf(job) === "amber";
      case "failed":
        return job.status === "failed";
      case "all":
      default:
        return true;
    }
  };
  // Sort for triage: in-progress first (still working), then green, amber, red.
  const TIER_RANK: Record<string, number> = {
    running: 0,
    pending: 0,
    green: 1,
    amber: 2,
    red: 3,
  };
  const confidenceRank = (j: AutolisterJob): number =>
    j.status === "pending" || j.status === "running"
      ? 0
      : TIER_RANK[tierOf(j)] ?? 9;
  const visibleJobs = [...jobs].filter(matchesFilter).sort((a, b) => {
    if (queueSort === "price") {
      return (priceOf(b) ?? -1) - (priceOf(a) ?? -1);
    }
    if (queueSort === "status") {
      return a.status.localeCompare(b.status);
    }
    // Default: confidence/tier triage order.
    return confidenceRank(a) - confidenceRank(b);
  });
  // Currently-selected, still-publishable (succeeded) jobs.
  const selectedPublishable = succeededJobs.filter((j) =>
    selectedIds.has(j.inventory_item_id)
  );
  function toggleSelected(itemId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  // Open the confirmation dialog (US-321) and run pre-flight /listings/validate
  // on each succeeded item in parallel. Blockers render per-row and gate the
  // "Publish N clean" button — items with unresolved blockers are refused.
  async function openPublishDialog(subset: AutolisterJob[] = succeededJobs) {
    if (subset.length === 0) return;
    // US-954: seed from the background pre-flight cache so a draft already
    // validated in the queue doesn't re-validate from scratch.
    const initial: PreflightItem[] = subset.map((j) => {
      const cached = preflightByItem[j.inventory_item_id];
      return {
        itemId: j.inventory_item_id,
        listingId: j.listing_id,
        title: titleOf(j.inventory_item_id),
        scheduledFor: null,
        blockers: cached?.loaded ? cached.blockers : [],
        blockersLoaded: cached?.loaded ?? false,
      };
    });
    setPreflight(initial);
    setPublishDialogOpen(true);
    // Only the items not already cached still need a validate round-trip.
    const needValidation = initial.filter((i) => !i.blockersLoaded);
    setPreflightLoading(needValidation.length > 0);

    try {
      // Pull scheduled_publish_at for these drafts so the dialog flags them.
      const itemIds = initial.map((i) => i.itemId);
      const { data: listingRows } = await supabase
        .from("listings")
        .select("inventory_item_id, scheduled_publish_at")
        .in("inventory_item_id", itemIds)
        .eq("listing_status", "draft");
      const scheduledByItem = new Map<string, string | null>();
      for (const row of (listingRows ?? []) as Array<
        { inventory_item_id: string; scheduled_publish_at: string | null }
      >) {
        scheduledByItem.set(row.inventory_item_id, row.scheduled_publish_at);
      }
      // Apply schedule info to every row (cached + uncached) immediately.
      setPreflight((prev) =>
        prev.map((p) => ({
          ...p,
          scheduledFor: scheduledByItem.get(p.itemId) ?? null,
        })),
      );

      // Validate only the uncached items, paced under the edge rate limiter
      // (US-1559), warming the shared cache as each completes. A failed or
      // rate-limited validate is a BLOCKER, never a silent "clean" — and it
      // isn't cached, so reopening the dialog re-validates it.
      await runWithConcurrency(needValidation, 2, async (it) => {
        await acquireValidateSlot(validateSlotRef);
        let blockers: string[];
        let cacheable = true;
        try {
          const res = await edgeFetch("/api/flipdesk/ebay/listings/validate", {
            method: "POST",
            json: { inventory_item_id: it.itemId },
          });
          if (!res.ok) {
            cacheable = false;
            blockers = [
              res.status === 429
                ? "Rate-limited while validating — wait a minute and reopen this dialog."
                : "Validation failed — reopen this dialog to retry.",
            ];
          } else {
            const json = await res.json().catch(() => ({}));
            blockers = Array.isArray(json.blockers)
              ? (json.blockers as string[])
              : [];
          }
        } catch (err) {
          cacheable = false;
          blockers = [
            err instanceof Error ? err.message : "Validation request failed.",
          ];
        }
        setPreflight((prev) =>
          prev.map((p) =>
            p.itemId === it.itemId
              ? { ...p, blockers, blockersLoaded: true }
              : p,
          ),
        );
        if (cacheable) {
          setPreflightByItem((prev) => ({
            ...prev,
            [it.itemId]: { blockers, loaded: true },
          }));
        }
      });
    } finally {
      setPreflightLoading(false);
    }
  }

  function confirmPublish() {
    const publishable = preflight.filter((p) => p.blockersLoaded && p.blockers.length === 0);
    if (publishable.length === 0) {
      toast.error("Nothing to publish — resolve the blockers first.");
      return;
    }
    setPublishDialogOpen(false);
    void bulkPublish.run(
      publishable.map((p) => ({ itemId: p.itemId, listingId: p.listingId })),
    );
  }

  // US-537: score the generated items' photos for listing-readiness and persist
  // the result, then refresh the per-row badges.
  async function checkPhotos() {
    const ids = succeededJobs.map((j) => j.inventory_item_id);
    if (ids.length === 0) return;
    try {
      const { results, requested, failedItemIds } = await runPhotoQa.mutateAsync({
        itemIds: ids,
      });
      await queryClient.invalidateQueries({ queryKey: ["autolister_item_meta"] });
      const scored = results.length;
      const flagged = results.filter((r) => r.score >= 0 && r.score < 80).length;
      const unscored = failedItemIds.length;
      const flaggedNote = flagged > 0 ? ` ${flagged} could use better photos.` : "";
      // US-1911: report partial success honestly (e.g. "Scored 240 of 300")
      // rather than one all-or-nothing error toast — the hook only rejects when
      // nothing at all could be scored.
      if (unscored > 0) {
        toast.warning(
          `Scored ${scored} of ${requested}.${flaggedNote} ${unscored} couldn't be checked — try again to finish.`,
        );
      } else {
        toast.success(
          flagged > 0
            ? `Checked ${scored} item${scored === 1 ? "" : "s"} —${flaggedNote}`
            : `Checked ${scored} item${scored === 1 ? "" : "s"} — photos look good.`,
        );
      }
    } catch {
      /* useRunPhotoQa surfaces the error toast (only a total failure now) */
    }
  }

  // Close the add-photos dialog. If the photo set changed while it was open,
  // re-score just that item so its "Photos NN" badge (and issue tooltip) reflect
  // the new photos — an open/close with no edits costs no QA call.
  async function closePhotoDialog() {
    const edited = photoItem;
    const dirty = photosDirtyRef.current;
    setPhotoItem(null);
    photosDirtyRef.current = false;
    if (!edited || !dirty) return;
    try {
      await runPhotoQa.mutateAsync({ itemIds: [edited.id] });
      await queryClient.invalidateQueries({ queryKey: ["autolister_item_meta"] });
    } catch {
      /* useRunPhotoQa surfaces the error toast; the photos are already saved */
    }
  }

  async function retryFailed() {
    if (failedItemIds.length === 0 || !batchId) return;
    // In-place retry: re-runs only the failed jobs in this batch and
    // increments each job's attempts. Re-poll the same batch_id.
    await retryFailedMutation.mutateAsync({ batchId });
    queryClient.invalidateQueries({ queryKey: ["autolister_batch", batchId] });
  }

  async function resumeBatch() {
    if (pendingCount === 0 || !batchId) return;
    try {
      const res = await resumeMutation.mutateAsync({ batchId });
      toast.success(`Resuming ${res.resumed} item${res.resumed === 1 ? "" : "s"}…`);
      queryClient.invalidateQueries({ queryKey: ["autolister_batch", batchId] });
    } catch {
      /* hook surfaces the error toast */
    }
  }

  return (
    <div className="space-y-6">
      {/* US-2520: same batch, three screens, one nav. */}
      <BatchNav batchId={batchId} current="queue" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {/* Its OWN route (/autolister/queue), reached from a batch rather
              than from the AutoLister host, so it owns the h1. */}
          <PageHeader
            title="Generating listings"
            subtitle={isRunning ? RUNNING_SUBTITLE : "Batch complete."}
          />
          {/* US-550: confidence-tier summary. */}
          {!isRunning && succeededJobs.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                {greenJobs.length} ready
              </span>
              {amberCount > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  {amberCount} needs review
                </span>
              )}
              {redCount > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  {redCount} failed
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* US-554: filter + sort the queue. */}
          {!isRunning && jobs.length > 0 && (
            <>
              <Select
                value={queueFilter}
                onValueChange={(v) =>
                  setQueueFilter(v as "all" | "ready" | "review" | "failed")}
              >
                <SelectTrigger aria-label="Filter drafts by status" className="h-9 w-[140px]">
                  <SelectValue placeholder="Filter" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All drafts</SelectItem>
                  <SelectItem value="ready">Ready only</SelectItem>
                  <SelectItem value="review">Needs review</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={queueSort}
                onValueChange={(v) =>
                  setQueueSort(v as "confidence" | "price" | "status")}
              >
                <SelectTrigger aria-label="Sort drafts" className="h-9 w-[150px]">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="confidence">Confidence</SelectItem>
                  <SelectItem value="price">Price: high → low</SelectItem>
                  <SelectItem value="status">Status</SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
          {/* US-554: publish only the multi-selected rows. */}
          {selectedPublishable.length > 0 && !isRunning && (
            <Button
              onClick={() => void openPublishDialog(selectedPublishable)}
              disabled={bulkPublish.running || !ebayConnection}
              title="Validate and publish the selected drafts."
            >
              {bulkPublish.running ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-2 h-4 w-4" />
              )}
              Publish {selectedPublishable.length} selected
            </Button>
          )}
          {pendingCount > 0 && (
            <Button
              variant="secondary"
              onClick={resumeBatch}
              disabled={resumeMutation.isPending}
              title="Re-run items still waiting — use this if generation stalled at 0/N after a server restart."
            >
              {resumeMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Resume {pendingCount} stuck
            </Button>
          )}
          {failedItemIds.length > 0 && !isRunning && (
            <Button
              variant="secondary"
              onClick={retryFailed}
              disabled={retryFailedMutation.isPending}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry {failedItemIds.length} failed
            </Button>
          )}
          {succeededJobs.length > 0 && (
            <Button
              variant="outline"
              onClick={() => void checkPhotos()}
              disabled={runPhotoQa.isPending}
              title="Score each item's photos for listing readiness and flag reshoots"
            >
              {runPhotoQa.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Camera className="mr-2 h-4 w-4" />
              )}
              Check photos ({succeededJobs.length})
            </Button>
          )}
          {/* US-550: one-click accept of the high-confidence (green) drafts. */}
          {greenJobs.length > 0 && !isRunning && (
            <Button
              onClick={() => void openPublishDialog(greenJobs)}
              disabled={bulkPublish.running || !ebayConnection}
              className="bg-emerald-600 hover:bg-emerald-700"
              title={
                !ebayConnection
                  ? "Connect eBay first on the Marketplaces page."
                  : "Validate and publish only the high-confidence (green) drafts."
              }
            >
              {bulkPublish.running ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-2 h-4 w-4" />
              )}
              Publish {greenJobs.length} green
            </Button>
          )}
          {succeededJobs.length > 0 && !isRunning && (
            <Button
              variant={greenJobs.length > 0 ? "outline" : "default"}
              onClick={() => void openPublishDialog()}
              disabled={bulkPublish.running || !ebayConnection}
              title={
                !ebayConnection
                  ? "Connect eBay first on the Marketplaces page."
                  : "Validate and publish every generated draft."
              }
            >
              {bulkPublish.running ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-2 h-4 w-4" />
              )}
              Publish all ({succeededJobs.length})
            </Button>
          )}
          {succeededJobs.length > 0 && (
            <Button asChild variant="outline">
              <Link to={`/dashboard/flipdesk/autolister/bulk-edit?batch=${batchId}`}>
                Bulk edit
              </Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to="/dashboard/flipdesk/autolister">New batch</Link>
          </Button>
        </div>
      </div>

      {/* Progress */}
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium">
            {done} / {batch.item_count} processed
          </span>
          <div className="flex items-center gap-3">
            <span className="text-emerald-600 dark:text-emerald-400">{batch.succeeded_count} done</span>
            {batch.failed_count > 0 && (
              <span className="text-destructive">{batch.failed_count} failed</span>
            )}
            <Badge
              variant={
                batch.status === "completed"
                  ? "default"
                  : batch.status === "failed"
                    ? "destructive"
                    : "secondary"
              }
            >
              {batch.status}
            </Badge>
          </div>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full transition-all",
              batch.failed_count > 0 && !isRunning ? "bg-amber-500" : "bg-primary",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        {batch.error && (
          <p className="mt-2 text-xs text-destructive">{batch.error}</p>
        )}
      </Card>

      {/* US-554: select-all / clear for the publishable rows in view. */}
      {!isRunning && succeededJobs.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => {
              const ids = visibleJobs
                .filter((j) => j.status === "success")
                .map((j) => j.inventory_item_id);
              setSelectedIds(new Set(ids));
            }}
          >
            Select all in view
          </button>
          {selectedIds.size > 0 && (
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => setSelectedIds(new Set())}
            >
              Clear ({selectedIds.size})
            </button>
          )}
          <span className="ml-auto">
            Showing {visibleJobs.length} of {jobs.length}
          </span>
        </div>
      )}

      {/* Per-item rows — virtualized (US-416) so a 1k+ item batch stays smooth. */}
      {!isRunning && visibleJobs.length === 0 && jobs.length > 0 && (
        <FilterEmpty noun="draft" total={jobs.length}
          clearLabel="Show all drafts" onClear={() => setQueueFilter("all")} />
      )}
      {visibleJobs.length > 0 && (
        <VirtualList
          items={visibleJobs}
          getKey={(job) => job.id}
          estimateSize={120}
          gap={8}
          className="max-h-[70dvh] pr-1"
          renderItem={(job) => {
            const pub = bulkPublish.results[job.inventory_item_id];
            // US-550: tier dot (only meaningful once a draft is generated).
            const tier = job.status === "success" ? tierOf(job) : null;
            const tierColor =
              tier === "green"
                ? "bg-emerald-500"
                : tier === "amber"
                  ? "bg-amber-500"
                  : null;
            const selectable = job.status === "success";
            return (
            <div className="space-y-1.5">
            <div
              className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
            >
              {/* US-554: multi-select a publishable (succeeded) draft. */}
              {selectable && !isRunning ? (
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-emerald-600"
                  checked={selectedIds.has(job.inventory_item_id)}
                  onChange={() => toggleSelected(job.inventory_item_id)}
                  aria-label={`Select ${titleOf(job.inventory_item_id)}`}
                />
              ) : (
                <span className="w-4 shrink-0" aria-hidden="true" />
              )}
              {tierColor && (
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-full", tierColor)}
                  aria-hidden="true"
                />
              )}
              <StatusIcon status={job.status} />
              <span className="flex-1 truncate">
                {titleOf(job.inventory_item_id)}
              </span>

              {/* US-537: photo readiness — nudge a reshoot before publish. */}
              <PhotoQaBadge meta={itemMeta[job.inventory_item_id]} />
              {/* Add or replace this draft's photos in place — fixes a missing
                  required photo without a round-trip to the composer. */}
              {job.status === "success" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
                  onClick={() => {
                    const m = itemMeta[job.inventory_item_id];
                    photosDirtyRef.current = false;
                    setPhotoItem({
                      id: job.inventory_item_id,
                      title: titleOf(job.inventory_item_id),
                      category: m?.category ?? null,
                      status: m?.status ?? null,
                    });
                  }}
                  title="Add or replace this draft's photos"
                >
                  <ImagePlus className="h-3 w-3" />
                  Add photos
                </Button>
              )}
              <MeasurementsBadge
                has={itemMeta[job.inventory_item_id]?.hasMeasurements}
              />

              {/* US-954: background eBay pre-flight — ready / will-block(reason)
                  before the publish dialog is ever opened. Will-block reasons
                  deep-link to the offending field in the composer. */}
              {job.status === "success" && (
                <PreflightBadge
                  itemId={job.inventory_item_id}
                  state={preflightByItem[job.inventory_item_id]}
                  enabled={!!ebayConnection}
                />
              )}

              {/* US-541: AI flagged this draft as low-confidence — surface a
                  "Needs review" nudge so the seller checks it before publish. */}
              {job.status === "success" &&
                job.listing_id &&
                reviewByListing[job.listing_id]?.needsReview && (
                  <Badge
                    variant="outline"
                    className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
                    title={
                      (reviewByListing[job.listing_id]?.fields.length ?? 0) > 0
                        ? `AI is unsure about: ${reviewByListing[job.listing_id]!.fields.join(", ")}`
                        : "The AI was uncertain about this listing — give it a look before publishing."
                    }
                  >
                    <AlertTriangle className="h-3 w-3" />
                    Needs review
                  </Badge>
                )}

              {/* Generation error */}
              {job.status === "failed" && job.error && !pub && (
                <span className="max-w-xs truncate text-xs text-destructive" title={job.error}>
                  {job.error}
                </span>
              )}

              {/* Publish state (once a bulk publish has touched this item) */}
              {pub?.status === "publishing" && (
                <Badge variant="secondary" className="gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Publishing
                </Badge>
              )}
              {pub?.status === "failed" && (
                // US-567: the mapped, actionable eBay message deep-links to the
                // composer so the seller can fix the offending field.
                <Link
                  to={`/dashboard/flipdesk/items/${job.inventory_item_id}/draft`}
                  className="max-w-xs truncate text-xs text-destructive underline-offset-2 hover:underline"
                  title={`${pub.error} — click to fix in the composer`}
                >
                  {pub.error}
                </Link>
              )}
              {pub?.status === "success" ? (
                pub.listingUrl ? (
                  <a
                    href={pub.listingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline dark:text-emerald-400"
                  >
                    Live on eBay
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <Badge variant="default">Live</Badge>
                )
              ) : (
                job.status === "success" && (
                  <Button asChild size="sm" variant="ghost">
                    <Link to={`/dashboard/flipdesk/items/${job.inventory_item_id}/draft`}>
                      Review
                      <ArrowRight className="ml-1 h-3 w-3" />
                    </Link>
                  </Button>
                )
              )}
            </div>

            {/* Field-by-field reconcile against the seller's imported record —
                only meaningful once the draft exists (status success). */}
            {job.status === "success" && (
              <ReconcilePanel
                itemId={job.inventory_item_id}
                title={titleOf(job.inventory_item_id)}
              />
            )}
            </div>
            );
          }}
        />
      )}

      <PublishConfirmDialog
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        items={preflight}
        loading={preflightLoading}
        onConfirm={confirmPublish}
      />

      {/* Add-photos in place: the full shared uploader (required slots, compression,
          EXIF strip, background removal) in a dialog so a seller can fix a missing
          required photo from the cockpit. On close we re-score QA only if the set
          changed (photosDirtyRef). */}
      <Dialog
        open={photoItem != null}
        onOpenChange={(open) => {
          if (!open) void closePhotoDialog();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate">
              Photos{photoItem ? ` — ${photoItem.title}` : ""}
            </DialogTitle>
            <DialogDescription>
              Add or replace this draft's photos. Required slots are marked; the
              row's photo score refreshes when you close.
            </DialogDescription>
          </DialogHeader>
          {photoItem && (
            <div className="max-h-[70dvh] overflow-y-auto pr-1">
              <PhotoUploader
                itemId={photoItem.id}
                currentStatus={photoItem.status ?? undefined}
                category={photoItem.category}
                onChange={() => {
                  photosDirtyRef.current = true;
                }}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => void closePhotoDialog()}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// US-537: per-item photo-readiness badge. Green ≥80, amber 50-79, red <50; the
// tooltip lists the specific reshoot prompts the vision pass returned.
// US-2520: PhotoQaBadge, MeasurementsBadge, PreflightBadge and
// PublishConfirmDialog moved to ./autolister/queue-cells.tsx.
