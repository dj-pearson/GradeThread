import { useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { BatchNav } from "./autolister/batch-nav";
import { PublishConfirmDialog } from "./autolister/queue-cells";
// US-3309: the rows are a table now, in their own module.
import { QueueTable, type QueueTier } from "./autolister/queue-table";
import {
  sizeCheckableDraft,
  useApplySizeFix,
  useSizeConflicts,
} from "./autolister/use-size-conflicts";
import { useAutolisterItemMeta } from "./autolister/use-item-meta";
import { useAutolisterListingReview } from "./autolister/use-listing-review";
import { ITEM_COVERS_KEY, useAutolisterItemCovers } from "./autolister/use-item-covers";
import { QueueColumnError } from "./autolister/queue-column-error";
import { usePublishPreflight } from "./autolister/use-publish-preflight";
import { queueRowTitle } from "./autolister/queue-row-title";
import { useBatchFinishedToast } from "./autolister/use-batch-finished-toast";
import { toast } from "sonner";
import { Loader2, RefreshCw, Rocket, Camera } from "lucide-react";
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
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import type { ItemCategory, ItemStatus } from "@/types/database";
import { cn } from "@/lib/utils";
import { FilterEmpty } from "@/components/flipdesk/filter-empty";

// AutoLister queue / progress view (US-318). Polls the batch until it finishes,
// shows per-item status, links completed drafts to the editor, and lets the
// user re-run only the failed items.

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

  // US-3381: the QUERY, not just its data. These throw on a refused read now
  // (US-3376), and isError/refetch are what turns that into something the
  // seller can see and act on instead of a blank column.
  const metaQuery = useAutolisterItemMeta(batchId, itemIds, itemIdsKey);
  const coversQuery = useAutolisterItemCovers(batchId, itemIds, itemIdsKey);
  const itemMeta = useMemo(() => metaQuery.data ?? {}, [metaQuery.data]);
  const coverByItem = coversQuery.data ?? {};

  // US-2919: does each generated draft's size agree with its own measurements?
  // Band tables are fetched once per distinct brand + garment + gender in the
  // batch; a draft with no size, no measurements or no chart produces nothing
  // at all, no warning and no empty state.
  const sizeDrafts = useMemo(
    () =>
      jobs.map((j) => {
        const m = itemMeta[j.inventory_item_id];
        return sizeCheckableDraft({
          itemId: j.inventory_item_id,
          name: m?.title ?? null,
          brand: m?.brand ?? null,
          garment: m?.garment ?? null,
          size: m?.size ?? null,
          measurements: m?.measurements ?? null,
        });
      }),
    [jobs, itemMeta],
  );
  const sizeConflicts = useSizeConflicts(sizeDrafts);
  const applySizeFix = useApplySizeFix();

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
  // US-541: which generated drafts the AI flagged as needing a human look, plus
  // the specific low-confidence fields (for the badge tooltip). Keyed by
  // listing_id; RLS scopes the read to the owner via the parent item.
  const listingIds = useMemo(
    () => jobs.map((j) => j.listing_id).filter((id): id is string => !!id),
    [jobs],
  );
  // Content key, not count — see itemIdsKey above.
  const listingIdsKey = useMemo(() => [...listingIds].sort().join(","), [listingIds]);
  const reviewQuery = useAutolisterListingReview(batchId, listingIds, listingIdsKey);
  const reviewByListing = reviewQuery.data ?? {};

  // The row label: generated listing title, then item title, then position.
  // The rule and its reasons live in autolister/queue-row-title.ts.
  const listingIdByItem = useMemo(() => {
    const map: Record<string, string> = {};
    for (const j of jobs) if (j.listing_id) map[j.inventory_item_id] = j.listing_id;
    return map;
  }, [jobs]);
  const titleOf = (id: string): string =>
    queueRowTitle({
      generated: listingIdByItem[id] ? reviewByListing[listingIdByItem[id]]?.title : null,
      itemTitle: itemMeta[id]?.title,
      ordinal: ordinalOf[id],
    });

  // US-321 / US-954: the whole eBay pre-flight lives in its own hook now
  // (US-3381). It needs titleOf, so it is called here rather than at the top.
  const preflight = usePublishPreflight({
    jobs,
    ebayConnected: !!ebayConnection,
    titleOf,
  });

  // US-3381 AC2: which per-batch columns could not be read. Named in the words
  // the seller sees on the table, not the hook names.
  const failedColumns: string[] = [];
  if (metaQuery.isError) failedColumns.push("item titles and photo scores");
  if (coversQuery.isError) failedColumns.push("thumbnails");
  if (reviewQuery.isError) failedColumns.push("review flags and prices");
  const retryFailedColumns = () => {
    if (metaQuery.isError) void metaQuery.refetch();
    if (coversQuery.isError) void coversQuery.refetch();
    if (reviewQuery.isError) void reviewQuery.refetch();
  };
  const columnsRetrying =
    (metaQuery.isError && metaQuery.isFetching) ||
    (coversQuery.isError && coversQuery.isFetching) ||
    (reviewQuery.isError && reviewQuery.isFetching);

  useBatchFinishedToast(data, batchId);

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
  type Tier = QueueTier;
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

  // US-3309: select-all now lives on the table's header checkbox, so it needs
  // to be a real toggle rather than the one-way "Select all in view" link it
  // replaced — a header checkbox that only ever selects is a checkbox that lies
  // about its own state.
  const selectableInView = visibleJobs.filter((j) => j.status === "success");
  const allInViewSelected =
    selectableInView.length > 0 &&
    selectableInView.every((j) => selectedIds.has(j.inventory_item_id));
  function toggleSelectAllInView() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const j of selectableInView) {
        if (allInViewSelected) next.delete(j.inventory_item_id);
        else next.add(j.inventory_item_id);
      }
      return next;
    });
  }

  function confirmPublish() {
    const publishable = preflight.items.filter((p) => p.blockersLoaded && p.blockers.length === 0);
    if (publishable.length === 0) {
      toast.error("Nothing to publish — resolve the blockers first.");
      return;
    }
    preflight.setDialogOpen(false);
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
    // The cover may have changed even if the re-score below fails.
    void queryClient.invalidateQueries({ queryKey: [ITEM_COVERS_KEY] });
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
              onClick={() => void preflight.open(selectedPublishable)}
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
              onClick={() => void preflight.open(greenJobs)}
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
              onClick={() => void preflight.open(succeededJobs)}
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

      {/* US-3309: the count strip. "Select all in view" moved onto the
          table's header checkbox, where a table puts it. */}
      {!isRunning && succeededJobs.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
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

      {/* US-3381 AC2: a refused column read says so, instead of rendering as
          a row full of blanks while TanStack retries behind it. */}
      <QueueColumnError
        columns={failedColumns}
        onRetry={retryFailedColumns}
        retrying={columnsRetrying}
      />

      {!isRunning && visibleJobs.length === 0 && jobs.length > 0 && (
        <FilterEmpty noun="draft" total={jobs.length}
          clearLabel="Show all drafts" onClear={() => setQueueFilter("all")} />
      )}
      {/* US-3309: columns, not one flex line. Virtualized (US-416) for a 1k+
          batch via the spacer-row technique, so the columns stay aligned. */}
      {visibleJobs.length > 0 && (
        <QueueTable
          jobs={visibleJobs}
          isRunning={isRunning}
          ebayConnected={!!ebayConnection}
          titleOf={titleOf}
          tierOf={(job) => (job.status === "success" ? tierOf(job) : null)}
          itemMeta={itemMeta}
          coverByItem={coverByItem}
          reviewByListing={reviewByListing}
          sizeConflicts={sizeConflicts}
          preflightByItem={preflight.byItem}
          publishResults={bulkPublish.results}
          selectedIds={selectedIds}
          onToggleSelected={toggleSelected}
          onToggleSelectAll={toggleSelectAllInView}
          allInViewSelected={allInViewSelected}
          onApplySizeFix={applySizeFix}
          onEditPhotos={(job) => {
            const m = itemMeta[job.inventory_item_id];
            photosDirtyRef.current = false;
            setPhotoItem({
              id: job.inventory_item_id,
              title: titleOf(job.inventory_item_id),
              category: m?.category ?? null,
              status: m?.status ?? null,
            });
          }}
        />
      )}

      <PublishConfirmDialog
        open={preflight.dialogOpen}
        onOpenChange={preflight.setDialogOpen}
        items={preflight.items}
        loading={preflight.loading}
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
