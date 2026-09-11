// US-3309: the AutoLister queue as a table with named columns.
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
//
// Every row was one `flex items-center gap-3` carrying up to fourteen children:
// checkbox, tier dot, status icon, a 40px thumb, the title, the photo-QA badge,
// an Add-photos button, the Measured badge, the size-conflict badge and its
// Change-to button, the pre-flight badge, the Needs-review badge, a generation
// error, a publish-state element, and the Review button.
//
// The shadcn Badge base class is `shrink-0`, and so are the buttons. The title
// was the only flexible child, so it absorbed every shortfall: at a normal
// dashboard width the fixed children came to more than the row, the title
// collapsed to an ellipsis, and the rest spilled past the border. The row got
// WORSE the more the page learned about a draft — a batch where the AI flagged
// sizes and photos rendered the least readable rows of all.
//
// Columns fix that by construction. A badge appearing changes the height of one
// cell; it cannot take width from the title, because the title's column is not
// where the badge lives.
//
// ── THE RECONCILE PANEL ─────────────────────────────────────────────────────
//
// It used to render under EVERY row as its own bordered box, collapsed, whether
// or not the draft had anything to reconcile — a second border per row for a
// panel most sellers never open. It is now the expandable detail row, so a
// chevron is all it costs when closed. It was already lazy (the diff loads on
// expand), so this moves no queries around.
//
// ── VIRTUALIZATION ──────────────────────────────────────────────────────────
//
// Kept, using the spacer-row technique from listings-table.tsx rather than the
// absolutely-positioned VirtualList the old rows used: a real <table> is what
// keeps the columns aligned across rows, which is the entire point of this
// change, and two padding rows are what let a table body be virtualized without
// giving that up.

import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReconcilePanel } from "@/components/flipdesk/reconcile-panel";
import { QueueCoverThumb } from "@/pages/flipdesk/autolister/queue-cells";
import {
  QueueCard,
  RowActions,
  SignalCell,
  StateCell,
  type QueueTableProps,
} from "@/pages/flipdesk/autolister/queue-row-parts";
import {
  money,
  tierDotClass,
  tierWord,
} from "@/pages/flipdesk/autolister/queue-row-format";
import type { AutolisterJob } from "@/hooks/use-autolister";
import { cn } from "@/lib/utils";

export type { QueueTableProps } from "@/pages/flipdesk/autolister/queue-row-parts";
export type { QueueTier } from "@/pages/flipdesk/autolister/queue-row-format";

/**
 * Above this many rows the table body is virtualized.
 *
 * Same threshold as the inventory table. Below it the spacer rows and the
 * measurement pass are pure cost, and a 40-draft batch is the common case.
 */
const VIRTUALIZE_ROW_THRESHOLD = 60;

export function QueueTable(props: QueueTableProps) {
  const { jobs } = props;
  const [expanded, setExpanded] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = jobs.length > VIRTUALIZE_ROW_THRESHOLD;
  // Always created (Rules of Hooks); only consumed when virtualizing. The
  // estimate is deliberately generous — a row with four signal badges and a
  // two-line title is taller than one with none, and under-estimating makes the
  // scrollbar jump as rows measure themselves.
  const rowVirtualizer = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 68,
    overscan: 8,
  });
  const virtualItems = virtualize ? rowVirtualizer.getVirtualItems() : [];
  const vPadTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const vPadBottom =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() -
        (virtualItems[virtualItems.length - 1]?.end ?? 0)
      : 0;

  function toggleExpanded(itemId: string) {
    setExpanded((cur) => (cur === itemId ? null : itemId));
  }

  const rows = virtualize
    ? virtualItems.map((vi) => ({
        job: jobs[vi.index],
        measureRef: rowVirtualizer.measureElement,
        vIndex: vi.index,
      }))
    : jobs.map((job) => ({
        job,
        measureRef: undefined,
        vIndex: undefined,
      }));

  return (
    <>
      {/* Phones: seven columns do not fit, so the same cells stack as cards. */}
      <div className="space-y-2 md:hidden">
        {jobs.map((job) => (
          <QueueCard
            key={job.id}
            job={job}
            open={expanded === job.inventory_item_id}
            onToggle={() => toggleExpanded(job.inventory_item_id)}
            {...props}
          />
        ))}
      </div>

      <div
        ref={scrollRef}
        className={cn(
          "hidden rounded-md border md:block",
          virtualize && "max-h-[70dvh] overflow-y-auto",
        )}
      >
        <Table>
          <TableHeader
            className={cn(virtualize && "sticky top-0 z-10 [&_th]:bg-background")}
          >
            <TableRow>
              <TableHead className="w-8 px-2">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 cursor-pointer accent-emerald-600"
                  checked={props.allInViewSelected}
                  onChange={props.onToggleSelectAll}
                  aria-label="Select all drafts in view"
                />
              </TableHead>
              <TableHead className="w-8" />
              <TableHead>Draft</TableHead>
              <TableHead className="w-[20rem]">Signals</TableHead>
              <TableHead className="w-24 text-right">Price</TableHead>
              <TableHead className="w-40">State</TableHead>
              <TableHead className="w-44 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {virtualize && vPadTop > 0 && (
              <tr aria-hidden="true" style={{ height: vPadTop }}>
                <td colSpan={7} />
              </tr>
            )}
            {rows.map(({ job, measureRef, vIndex }) =>
              job ? (
                <QueueRows
                  key={job.id}
                  job={job}
                  open={expanded === job.inventory_item_id}
                  onToggle={() => toggleExpanded(job.inventory_item_id)}
                  measureRef={measureRef}
                  vIndex={vIndex}
                  {...props}
                />
              ) : null,
            )}
            {virtualize && vPadBottom > 0 && (
              <tr aria-hidden="true" style={{ height: vPadBottom }}>
                <td colSpan={7} />
              </tr>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/**
 * Returns TWO `tr`s: the summary and, when open, the reconcile detail.
 *
 * A fragment rather than a nested table because a `tr` inside a `td` is not a
 * table row as far as the browser is concerned — the columns stop lining up,
 * which is the one thing this rewrite exists to guarantee.
 */
function QueueRows({
  job,
  open,
  onToggle,
  measureRef,
  vIndex,
  ...props
}: QueueTableProps & {
  job: AutolisterJob;
  open: boolean;
  onToggle: () => void;
  measureRef?: (el: HTMLElement | null) => void;
  vIndex?: number;
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
  const dot = tierDotClass(tier);
  const selectable = job.status === "success" && !isRunning;
  const price = job.listing_id ? reviewByListing[job.listing_id]?.price : null;

  return (
    <>
      <TableRow
        ref={measureRef}
        data-index={vIndex}
        className="align-top"
        data-state={open ? "selected" : undefined}
      >
        <TableCell className="px-2">
          {selectable ? (
            <input
              type="checkbox"
              className="h-3.5 w-3.5 cursor-pointer accent-emerald-600"
              checked={selectedIds.has(itemId)}
              onChange={() => onToggleSelected(itemId)}
              aria-label={`Select ${titleOf(itemId)}`}
            />
          ) : (
            <span className="block w-3.5" aria-hidden="true" />
          )}
        </TableCell>
        <TableCell className="px-1">
          {/* Only a generated draft has anything to reconcile against the
              seller's imported record, so a queued row gets no chevron rather
              than one that opens an empty panel. */}
          {job.status === "success" ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={
                open ? "Hide reconcile" : "Reconcile against your record"
              }
              className="text-muted-foreground hover:text-foreground"
              onClick={onToggle}
            >
              {open ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          ) : (
            <span className="block w-4" aria-hidden="true" />
          )}
        </TableCell>
        <TableCell className="whitespace-normal">
          <div className="flex items-start gap-2">
            <QueueCoverThumb cover={coverByItem[itemId]} label={titleOf(itemId)} />
            <div className="min-w-0">
              <span className="line-clamp-2 text-sm font-medium">
                {titleOf(itemId)}
              </span>
              {/* US-550: the confidence tier, as a word rather than a bare dot.
                  A coloured dot with no label is legible only to whoever built
                  it, and it was competing with five badges for the same row. */}
              {dot && (
                <span className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn("h-2 w-2 rounded-full", dot)}
                    aria-hidden="true"
                  />
                  {tierWord(tier)}
                </span>
              )}
            </div>
          </div>
        </TableCell>
        <TableCell className="whitespace-normal">
          <SignalCell job={job} {...props} />
        </TableCell>
        <TableCell className="text-right tabular-nums">{money(price)}</TableCell>
        <TableCell className="whitespace-normal">
          <StateCell job={job} publishResults={props.publishResults} />
        </TableCell>
        <TableCell className="text-right">
          <RowActions job={job} onEditPhotos={props.onEditPhotos} />
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={7} className="whitespace-normal p-3">
            <ReconcilePanel itemId={itemId} title={titleOf(itemId)} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
