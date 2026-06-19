import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
  CalendarClock,
  ShieldCheck,
  AlertTriangle,
  Camera,
} from "lucide-react";
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
import { blockerTarget } from "@/lib/publish-blockers";
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
import type { PhotoQaIssue } from "@/types/database";
import { cn } from "@/lib/utils";

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

interface PreflightItem {
  itemId: string;
  listingId: string | null;
  title: string;
  scheduledFor: string | null;
  blockers: string[]; // populated by /listings/validate
  blockersLoaded: boolean;
}

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
  // US-554: queue filter/sort + multi-select.
  const [queueFilter, setQueueFilter] = useState<"all" | "ready" | "review" | "failed">("all");
  const [queueSort, setQueueSort] = useState<"confidence" | "price" | "status">("confidence");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const runPhotoQa = useRunPhotoQa();

  const jobs = useMemo(() => data?.jobs ?? [], [data]);
  const itemIds = useMemo(() => jobs.map((j) => j.inventory_item_id), [jobs]);

  // Item titles + persisted photo-QA (US-537) for friendlier, actionable rows.
  interface ItemMeta {
    title: string;
    qaScore: number | null;
    qaIssues: PhotoQaIssue[];
  }
  const { data: itemMeta = {} } = useQuery<Record<string, ItemMeta>>({
    queryKey: ["autolister_item_meta", batchId, itemIds.length],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      // US-554: chunk so large batches don't overflow the `in` list.
      const CHUNK = 200;
      const map: Record<string, ItemMeta> = {};
      for (let i = 0; i < itemIds.length; i += CHUNK) {
        const { data: rows } = await supabase
          .from("inventory_items")
          .select("id, title, photo_qa_score, photo_qa_issues")
          .in("id", itemIds.slice(i, i + CHUNK));
        for (
          const r of (rows ?? []) as Array<{
            id: string;
            title: string;
            photo_qa_score: number | null;
            photo_qa_issues: PhotoQaIssue[] | null;
          }>
        ) {
          map[r.id] = {
            title: r.title,
            qaScore: r.photo_qa_score,
            qaIssues: r.photo_qa_issues ?? [],
          };
        }
      }
      return map;
    },
  });
  const titleOf = (id: string): string => itemMeta[id]?.title ?? id;

  // US-541: which generated drafts the AI flagged as needing a human look, plus
  // the specific low-confidence fields (for the badge tooltip). Keyed by
  // listing_id; RLS scopes the read to the owner via the parent item.
  const listingIds = useMemo(
    () => jobs.map((j) => j.listing_id).filter((id): id is string => !!id),
    [jobs],
  );
  const { data: reviewByListing = {} } = useQuery<
    Record<string, { needsReview: boolean; fields: string[]; price: number | null }>
  >({
    queryKey: ["autolister_listing_review", batchId, listingIds.length],
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
    const succeeded = jobs
      .filter((j) => j.status === "success")
      .map((j) => j.inventory_item_id);
    const pending = succeeded.filter((id) => !preflightSeenRef.current.has(id));
    if (pending.length === 0) return;
    pending.forEach((id) => preflightSeenRef.current.add(id));

    let cancelled = false;
    void runWithConcurrency(pending, 4, async (itemId) => {
      if (cancelled) return;
      try {
        const res = await edgeFetch("/api/flipdesk/ebay/listings/validate", {
          method: "POST",
          json: { inventory_item_id: itemId },
        });
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

      // Validate only the uncached items, with bounded concurrency (eBay rate
      // budget), warming the shared cache as each completes.
      await runWithConcurrency(needValidation, 4, async (it) => {
        let blockers: string[];
        try {
          const res = await edgeFetch("/api/flipdesk/ebay/listings/validate", {
            method: "POST",
            json: { inventory_item_id: it.itemId },
          });
          const json = await res.json().catch(() => ({}));
          blockers = Array.isArray(json.blockers)
            ? (json.blockers as string[])
            : [];
        } catch (err) {
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
        setPreflightByItem((prev) => ({
          ...prev,
          [it.itemId]: { blockers, loaded: true },
        }));
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
      const { results } = await runPhotoQa.mutateAsync({ itemIds: ids });
      await queryClient.invalidateQueries({ queryKey: ["autolister_item_meta"] });
      const flagged = results.filter((r) => r.score >= 0 && r.score < 80).length;
      toast.success(
        flagged > 0
          ? `Checked ${results.length} item${results.length === 1 ? "" : "s"} — ${flagged} could use better photos.`
          : `Checked ${results.length} item${results.length === 1 ? "" : "s"} — photos look good.`,
      );
    } catch {
      /* useRunPhotoQa surfaces the error toast */
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Generating listings</h1>
          <p className="text-sm text-muted-foreground">
            {isRunning
              ? "AI is generating your listings — this page updates automatically."
              : "Batch complete."}
          </p>
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
                <SelectTrigger className="h-9 w-[140px]">
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
                <SelectTrigger className="h-9 w-[150px]">
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
        <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
          No drafts match this filter.
        </p>
      )}
      {visibleJobs.length > 0 && (
        <VirtualList
          items={visibleJobs}
          getKey={(job) => job.id}
          estimateSize={120}
          gap={8}
          className="max-h-[70vh] pr-1"
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
    </div>
  );
}

// US-537: per-item photo-readiness badge. Green ≥80, amber 50-79, red <50; the
// tooltip lists the specific reshoot prompts the vision pass returned.
function PhotoQaBadge({
  meta,
}: {
  meta?: { qaScore: number | null; qaIssues: PhotoQaIssue[] };
}) {
  if (!meta || meta.qaScore == null) return null;
  const score = meta.qaScore;
  const cls =
    score >= 80
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : score >= 50
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-destructive/40 bg-destructive/10 text-destructive";
  const tip =
    meta.qaIssues.length > 0
      ? meta.qaIssues.map((i) => `• ${i.message}`).join("\n")
      : "Photos look ready to publish.";
  return (
    <Badge variant="outline" className={cn("gap-1 text-[10px]", cls)} title={tip}>
      <Camera className="h-3 w-3" />
      Photos {score}
    </Badge>
  );
}

// US-954: per-row eBay pre-flight badge. Driven by the background validation
// cache: "Checking…" while in flight, green "Ready" when clean, amber
// "Will block" (deep-linking the first blocker to the offending composer field)
// when there are unresolved blockers. Hidden until eBay is connected, since the
// publish actions are gated on the connection anyway.
function PreflightBadge({
  itemId,
  state,
  enabled,
}: {
  itemId: string;
  state?: { blockers: string[]; loaded: boolean };
  enabled: boolean;
}) {
  if (!enabled) return null;
  if (!state || !state.loaded) {
    return (
      <Badge
        variant="outline"
        className="gap-1 text-[10px] text-muted-foreground"
        title="Checking this draft against eBay…"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking…
      </Badge>
    );
  }
  if (state.blockers.length === 0) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300"
        title="Passes eBay pre-flight — ready to publish."
      >
        <ShieldCheck className="h-3 w-3" />
        Ready
      </Badge>
    );
  }
  // Will block — deep-link the badge to the first blocker's field, list them all
  // in the tooltip.
  const first = state.blockers[0] ?? "Resolve before publishing.";
  const target = blockerTarget(first, itemId);
  const tip = state.blockers.map((b) => `• ${b}`).join("\n");
  const count = state.blockers.length;
  return (
    <Link
      to={target.to}
      title={tip}
      className="inline-flex"
    >
      <Badge
        variant="outline"
        className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
      >
        <AlertTriangle className="h-3 w-3" />
        Will block{count > 1 ? ` (${count})` : ""}
      </Badge>
    </Link>
  );
}

function PublishConfirmDialog({
  open,
  onOpenChange,
  items,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PreflightItem[];
  loading: boolean;
  onConfirm: () => void;
}) {
  const publishable = items.filter((i) => i.blockersLoaded && i.blockers.length === 0).length;
  const blocked = items.filter((i) => i.blockersLoaded && i.blockers.length > 0).length;
  const scheduled = items.filter((i) => i.scheduledFor).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Publish {items.length} drafts to eBay?</DialogTitle>
          <DialogDescription>
            We pre-flight each draft against eBay business policies and category
            specifics. Items with unresolved blockers are skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <strong>{publishable}</strong> ready
            </span>
            {blocked > 0 && (
              <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                <strong>{blocked}</strong> blocked
              </span>
            )}
            {scheduled > 0 && (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <CalendarClock className="h-4 w-4" />
                <strong>{scheduled}</strong> scheduled
              </span>
            )}
            {loading && (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Validating…
              </span>
            )}
          </div>

          <div className="divide-y rounded-md border">
            {items.map((item) => (
              <div key={item.itemId} className="flex items-start gap-2 px-3 py-2 text-sm">
                <div className="mt-0.5">
                  {!item.blockersLoaded ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : item.blockers.length === 0 ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{item.title}</div>
                  {item.scheduledFor && (
                    <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <CalendarClock className="h-3 w-3" />
                      Scheduled for {new Date(item.scheduledFor).toLocaleString()}
                    </div>
                  )}
                  {item.blockers.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-300">
                      {item.blockers.map((b, i) => {
                        // US-954: deep-link each blocker to the offending field.
                        const target = blockerTarget(b, item.itemId);
                        return (
                          <li key={i}>
                            •{" "}
                            <Link
                              to={target.to}
                              className="underline-offset-2 hover:underline"
                              title={`${target.label} →`}
                            >
                              {b}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            ))}
            {items.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                Nothing to publish.
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={loading || publishable === 0}>
            <Rocket className="mr-2 h-4 w-4" />
            Publish {publishable} clean {publishable === 1 ? "draft" : "drafts"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
