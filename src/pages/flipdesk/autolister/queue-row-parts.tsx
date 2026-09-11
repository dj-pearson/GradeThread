// US-3309: the queue row's cells, and the phone card built from the same ones.
//
// Split out of queue-table.tsx because the US-2520 ratchet holds every module in
// this directory under 500 lines, and because it is the honest seam: this file
// is what ONE draft looks like, and queue-table.tsx is how a list of them is
// laid out and virtualized. The phone card lives here rather than beside the
// table for the same reason — it is the same four cells stacked, and keeping it
// next to them is what stops the two breakpoints from drifting.

import { Link } from "react-router";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  ImagePlus,
  Loader2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReconcilePanel } from "@/components/flipdesk/reconcile-panel";
import {
  MeasurementsBadge,
  PhotoQaBadge,
  PreflightBadge,
  QueueCoverThumb,
  SizeConflictBadge,
} from "@/pages/flipdesk/autolister/queue-cells";
import type { ItemMeta } from "@/pages/flipdesk/autolister/use-item-meta";
import type { ListingReview } from "@/pages/flipdesk/autolister/use-listing-review";
import type { SizeConflict } from "@/pages/flipdesk/autolister/group-warnings";
import type { PhotoLike } from "@/lib/item-photo-url";
import type {
  AutolisterJob,
  BulkPublishItemResult,
} from "@/hooks/use-autolister";
import {
  money,
  tierWord,
} from "@/pages/flipdesk/autolister/queue-row-format";

export type { QueueTier } from "@/pages/flipdesk/autolister/queue-row-format";
import type { QueueTier } from "@/pages/flipdesk/autolister/queue-row-format";

export interface QueueTableProps {
  jobs: AutolisterJob[];
  isRunning: boolean;
  ebayConnected: boolean;

  /** The row label, already resolved (generated title, item title, ordinal). */
  titleOf: (itemId: string) => string;
  /** Green/amber/red for a succeeded draft, null while it is still generating. */
  tierOf: (job: AutolisterJob) => QueueTier | null;

  itemMeta: Record<string, ItemMeta>;
  coverByItem: Record<string, PhotoLike | undefined>;
  reviewByListing: Record<string, ListingReview>;
  sizeConflicts: Record<string, SizeConflict>;
  preflightByItem: Record<string, { blockers: string[]; loaded: boolean }>;
  publishResults: Record<string, BulkPublishItemResult | undefined>;

  selectedIds: Set<string>;
  onToggleSelected: (itemId: string) => void;
  onToggleSelectAll: () => void;
  allInViewSelected: boolean;

  onApplySizeFix: (itemId: string, nextSize: string) => void;
  onEditPhotos: (job: AutolisterJob) => void;
}

export function StatusIcon({ status }: { status: AutolisterJob["status"] }) {
  switch (status) {
    case "success":
      return (
        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
      );
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

/**
 * The status as a WORD, not only an icon.
 *
 * The old row carried a bare coloured icon and a bare coloured dot side by
 * side, meaning two different things, and neither was labelled.
 */
const STATUS_WORD: Record<AutolisterJob["status"], string> = {
  success: "Generated",
  failed: "Failed",
  running: "Writing",
  pending: "Queued",
};


/**
 * Every badge the page can put on a draft, in one wrapping cell.
 *
 * This is the column that used to squeeze the title. Here the badges wrap
 * within their own width, so four signals make the row one line taller rather
 * than making the title unreadable.
 */
export function SignalCell({
  job,
  itemMeta,
  reviewByListing,
  sizeConflicts,
  preflightByItem,
  ebayConnected,
  onApplySizeFix,
}: Pick<
  QueueTableProps,
  | "itemMeta"
  | "reviewByListing"
  | "sizeConflicts"
  | "preflightByItem"
  | "ebayConnected"
  | "onApplySizeFix"
> & { job: AutolisterJob }) {
  const review = job.listing_id ? reviewByListing[job.listing_id] : undefined;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <PhotoQaBadge meta={itemMeta[job.inventory_item_id]} />
      <MeasurementsBadge has={itemMeta[job.inventory_item_id]?.hasMeasurements} />
      {/* US-2919: the size on the label disagrees with the numbers on the item.
          Never gates publish — it offers the fix and stops. */}
      <SizeConflictBadge
        conflict={sizeConflicts[job.inventory_item_id]}
        onFix={onApplySizeFix}
      />
      {/* US-954: background eBay pre-flight — ready / will-block(reason) before
          the publish dialog is ever opened. */}
      {job.status === "success" && (
        <PreflightBadge
          itemId={job.inventory_item_id}
          state={preflightByItem[job.inventory_item_id]}
          enabled={ebayConnected}
        />
      )}
      {/* US-541: the AI flagged this draft as low-confidence. */}
      {job.status === "success" && review?.needsReview && (
        <Badge
          variant="outline"
          className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
          title={
            review.fields.length > 0
              ? `AI is unsure about: ${review.fields.join(", ")}`
              : "The AI was uncertain about this listing — give it a look before publishing."
          }
        >
          <AlertTriangle className="h-3 w-3" />
          Needs review
        </Badge>
      )}
    </div>
  );
}

/**
 * What happened to this draft, in words.
 *
 * Generation status until a bulk publish touches the row, then the publish
 * result. Those are the same question asked at two stages, so they share one
 * column — which is what stops a published row from being wider than a queued
 * one and re-introducing the squeeze this rebuild removed.
 */
export function StateCell({
  job,
  publishResults,
}: {
  job: AutolisterJob;
  publishResults: QueueTableProps["publishResults"];
}) {
  const pub = publishResults[job.inventory_item_id];

  if (pub?.status === "publishing") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Publishing
      </Badge>
    );
  }
  if (pub?.status === "failed") {
    // US-567: the mapped, actionable eBay message deep-links to the composer so
    // the seller can fix the offending field.
    return (
      <Link
        to={`/dashboard/flipdesk/items/${job.inventory_item_id}/draft`}
        className="line-clamp-2 text-xs text-destructive underline-offset-2 hover:underline"
        title={`${pub.error} — click to fix in the composer`}
      >
        {pub.error}
      </Link>
    );
  }
  if (pub?.status === "success") {
    return pub.listingUrl ? (
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
    );
  }
  if (job.status === "failed" && job.error) {
    return (
      <span className="line-clamp-2 text-xs text-destructive" title={job.error}>
        {job.error}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <StatusIcon status={job.status} />
      {STATUS_WORD[job.status]}
    </span>
  );
}

export function RowActions({
  job,
  onEditPhotos,
  compact = false,
}: {
  job: AutolisterJob;
  onEditPhotos: QueueTableProps["onEditPhotos"];
  compact?: boolean;
}) {
  if (job.status !== "success") return null;
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="h-8 gap-1 px-2 text-xs text-muted-foreground"
        onClick={() => onEditPhotos(job)}
        title="Add or replace this draft's photos"
        aria-label="Add or replace this draft's photos"
      >
        <ImagePlus className="h-3.5 w-3.5" />
        {!compact && "Photos"}
      </Button>
      <Button asChild size="sm" variant="outline" className="h-8">
        <Link to={`/dashboard/flipdesk/items/${job.inventory_item_id}/draft`}>
          Review
          <ArrowRight className="ml-1 h-3 w-3" />
        </Link>
      </Button>
    </div>
  );
}

/**
 * The same draft on a phone.
 *
 * Seven columns do not fit, so the cells stack. Everything below the title is
 * the identical component the table cell renders, which is what keeps the two
 * breakpoints from telling a seller different things about the same draft.
 */
export function QueueCard({
  job,
  open,
  onToggle,
  ...props
}: QueueTableProps & {
  job: AutolisterJob;
  open: boolean;
  onToggle: () => void;
}) {
  const {
    isRunning,
    titleOf,
    tierOf,
    coverByItem,
    reviewByListing,
    selectedIds,
    onToggleSelected,
  } = props;
  const itemId = job.inventory_item_id;
  const tier = job.status === "success" ? tierOf(job) : null;
  const selectable = job.status === "success" && !isRunning;
  const price = job.listing_id ? reviewByListing[job.listing_id]?.price : null;
  const lowConfidenceFields = job.listing_id
    ? (reviewByListing[job.listing_id]?.fields ?? [])
    : [];

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start gap-2">
        {selectable && (
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-emerald-600"
            checked={selectedIds.has(itemId)}
            onChange={() => onToggleSelected(itemId)}
            aria-label={`Select ${titleOf(itemId)}`}
          />
        )}
        <QueueCoverThumb cover={coverByItem[itemId]} label={titleOf(itemId)} />
        <div className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm font-medium">
            {titleOf(itemId)}
          </span>
          <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
            {money(price)}
            {tierWord(tier) ? ` · ${tierWord(tier)}` : ""}
          </span>
        </div>
      </div>
      <div className="mt-2">
        <StateCell job={job} publishResults={props.publishResults} />
      </div>
      <div className="mt-2">
        <SignalCell job={job} {...props} />
      </div>
      {/* A badge tooltip is unreachable on a phone, so the fields the AI was
          unsure about are spelled out instead of hidden behind a hover. */}
      {lowConfidenceFields.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          AI is unsure about: {lowConfidenceFields.join(", ")}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        {job.status === "success" ? (
          <button
            type="button"
            aria-expanded={open}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={onToggle}
          >
            {open ? "Hide reconcile" : "Reconcile"}
          </button>
        ) : (
          <span />
        )}
        <RowActions job={job} onEditPhotos={props.onEditPhotos} compact />
      </div>
      {open && (
        <div className="mt-2">
          <ReconcilePanel itemId={itemId} title={titleOf(itemId)} />
        </div>
      )}
    </div>
  );
}
