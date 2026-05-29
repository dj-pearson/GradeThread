import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Loader2,
  XCircle,
  Clock,
  RefreshCw,
  ArrowRight,
  Rocket,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import {
  useAutolisterBatch,
  useBulkPublish,
  useStartAutolisterBatch,
  type AutolisterJob,
} from "@/hooks/use-autolister";
import { useEbayConnection } from "@/hooks/use-ebay";
import { cn } from "@/lib/utils";

// AutoLister queue / progress view (US-318). Polls the batch until it finishes,
// shows per-item status, links completed drafts to the editor, and lets the
// user re-run only the failed items.

function StatusIcon({ status }: { status: AutolisterJob["status"] }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

export function FlipdeskAutolisterQueuePage() {
  const [params] = useSearchParams();
  const batchId = params.get("batch");
  const { data, isLoading, error } = useAutolisterBatch(batchId);
  const startBatch = useStartAutolisterBatch();
  const bulkPublish = useBulkPublish();
  const { data: ebayConnection } = useEbayConnection();

  const jobs = useMemo(() => data?.jobs ?? [], [data]);
  const itemIds = useMemo(() => jobs.map((j) => j.inventory_item_id), [jobs]);

  // Item titles for friendlier rows.
  const { data: titles = {} } = useQuery<Record<string, string>>({
    queryKey: ["autolister_item_titles", batchId, itemIds.length],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("inventory_items")
        .select("id, title")
        .in("id", itemIds);
      const map: Record<string, string> = {};
      for (const r of (rows ?? []) as Array<{ id: string; title: string }>) {
        map[r.id] = r.title;
      }
      return map;
    },
  });

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
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading batch…
      </div>
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

  function publishAll() {
    void bulkPublish.run(
      succeededJobs.map((j) => ({ itemId: j.inventory_item_id, listingId: j.listing_id })),
    );
  }

  async function retryFailed() {
    if (failedItemIds.length === 0) return;
    const res = await startBatch.mutateAsync({ item_ids: failedItemIds });
    // Navigate via full URL so the polling query keys reset cleanly.
    window.location.href = `/dashboard/flipdesk/autolister/queue?batch=${res.batch_id}`;
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
        </div>
        <div className="flex items-center gap-2">
          {failedItemIds.length > 0 && !isRunning && (
            <Button variant="secondary" onClick={retryFailed} disabled={startBatch.isPending}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry {failedItemIds.length} failed
            </Button>
          )}
          {succeededJobs.length > 0 && !isRunning && (
            <Button
              onClick={publishAll}
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
            <span className="text-emerald-600">{batch.succeeded_count} done</span>
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

      {/* Per-item rows */}
      <div className="space-y-2">
        {jobs.map((job) => {
          const pub = bulkPublish.results[job.inventory_item_id];
          return (
            <div
              key={job.id}
              className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <StatusIcon status={job.status} />
              <span className="flex-1 truncate">
                {titles[job.inventory_item_id] ?? job.inventory_item_id}
              </span>

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
                <span className="max-w-xs truncate text-xs text-destructive" title={pub.error}>
                  {pub.error}
                </span>
              )}
              {pub?.status === "success" ? (
                pub.listingUrl ? (
                  <a
                    href={pub.listingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline"
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
          );
        })}
      </div>
    </div>
  );
}
