// US-2173 AC3: the desktop listings table, lifted out of listings.tsx.
//
// This is a VERBATIM move — the JSX below is byte-for-byte what the page
// rendered, so the refactor cannot change a column, a sort affordance or a
// row action. Everything it used to read from the enclosing component's
// scope is now a prop, and the compiler is what proved the list complete.
//
// US-733: virtualization is the caller's decision and arrives as props. The
// threshold, the spacer-row technique and the always-create-the-hook rule all
// stay on the page side, because the hook has to run in the same order on
// every render and this component is not always mounted (mobile renders
// ItemCardList instead).

import type { ReactNode, RefObject } from "react";
import { Link, type NavigateFunction } from "react-router";
import type { Virtualizer, VirtualItem } from "@tanstack/react-virtual";
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Clock,
  ExternalLink,
  FileText,
  Layers,
  Pencil,
  Rocket,
  RotateCcw,
  Star,
  Trash2,
  Truck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ClickableRow } from "@/components/clickable-row";
import { InlineCell } from "@/components/flipdesk/inline-cell";
import { InlineStatusSelect } from "@/components/flipdesk/inline-status-select";
import { ItemPhotoImg } from "@/components/flipdesk/item-photo-img";
import { QualityScoreChip } from "@/components/flipdesk/quality-score-chip";
import { payoutState } from "@/pages/flipdesk/listings-filter";
import type { usePageRowDetails } from "@/pages/flipdesk/listings-page-queries";
import {
  daysSince,
  fmtMoney,
  marginPct,
  scoreColor,
  shipByInfo,
} from "@/pages/flipdesk/listings-format";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { itemPhotoThumb } from "@/lib/images";
import { itemDisplayTitle, itemRowLabel } from "@/lib/item-row-label";
import { needsSignedDisplayUrl } from "@/lib/item-photo-url";
import type { ItemFullRow, ItemStatus } from "@/types/database";
import type { ListingPlatform } from "@/types/database";
import { staleSinceLabel, usePendingRevises } from "@/hooks/use-pending-revises";
import { useRelistExtension } from "@/hooks/use-relist-extension";
import { MARKETPLACE_MECHANISM } from "@/lib/constants";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import type { useEbayConnection } from "@/hooks/use-ebay";

// The per-row detail maps come straight off the shared query hook rather than
// being re-declared here, so adding a field to that hook cannot leave this
// component's props describing an older shape.
type RowDetails = ReturnType<typeof usePageRowDetails>;

export type ColumnSort = { field: keyof ItemFullRow; dir: "asc" | "desc" } | null;

interface Props {
  // ── the rows, and which tab they are being shown under ──────────────────
  pageRows: ItemFullRow[];
  tab: string;
  isActive: boolean;
  isDrafts: boolean;
  isShipped: boolean;
  isSold: boolean;
  isToList: boolean;

  // ── selection ───────────────────────────────────────────────────────────
  selectable: boolean;
  selected: Set<string>;
  allOnPageSelected: boolean;
  toggleSelected: (id: string) => void;
  toggleSelectAll: () => void;

  // ── sorting ─────────────────────────────────────────────────────────────
  columnSort: ColumnSort;
  toggleColumnSort: (field: keyof ItemFullRow) => void;

  // ── US-733 virtualization, decided by the caller ────────────────────────
  // The hook has to be created on every render (Rules of Hooks) and this
  // component is not always mounted, so it stays on the page and its output
  // arrives here.
  tableScrollRef: RefObject<HTMLDivElement | null>;
  virtualize: boolean;
  virtualItems: VirtualItem[];
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  vPadTop: number;
  vPadBottom: number;

  // ── per-row detail, page-scoped (US-2168) ───────────────────────────────
  platformsByItem: RowDetails["platformsByItem"];
  draftMetaByItem: RowDetails["draftMetaByItem"];
  publishIssuesByItem: RowDetails["publishIssuesByItem"];
  coverByItem: RowDetails["coverByItem"];
  metricsByItem: RowDetails["metricsByItem"];
  qualityByListing: RowDetails["qualityByListing"];
  scoreById: Map<string, number>;
  buyerCounts: Map<string, number>;

  // ── inline edits ────────────────────────────────────────────────────────
  updateTracking: (it: ItemFullRow, raw: string) => Promise<void>;
  updateListingPrice: (it: ItemFullRow, raw: string) => Promise<void>;
  updateItemStatus: (it: ItemFullRow, next: ItemStatus) => Promise<void>;
  // The base column and the view alias differ (acquired_price vs
  // purchase_price), so both travel — that mismatch is why the optimistic
  // patch needs a separate key from the write.
  updateItemMoney: (
    it: ItemFullRow,
    raw: string,
    column: "acquired_price" | "target_price",
    viewKey: "purchase_price" | "target_price",
    label: string,
  ) => Promise<void>;
  updateItemNotes: (it: ItemFullRow, raw: string) => Promise<void>;
  markDelivered: (it: ItemFullRow) => Promise<void>;

  // ── row actions that open a dialog on the page ──────────────────────────
  setPublishItem: (it: ItemFullRow | null) => void;
  setMarkListedItem: (it: ItemFullRow | null) => void;
  setRecordSaleItem: (it: ItemFullRow | null) => void;
  setShipItem: (it: ItemFullRow | null) => void;
  setEndTarget: (it: ItemFullRow | null) => void;
  setDeleteTarget: (it: ItemFullRow | null) => void;

  ebayConnection: ReturnType<typeof useEbayConnection>["data"];
  navigate: NavigateFunction;
}

// Sortable column header. Moved here with the table — the page has no other
// caller now that the header row lives in this component.
//
// EVERY header that CAN sort now does. Sorting happens in the database
// (flipdesk_listing_page, migration 00515), which validates the field against
// items_full's real columns — so a header can only be sortable when the value
// it displays comes from a column, and the whole page is ordered, not just the
// rows already fetched.
//
// The six that stay unsorted, and why, so nobody re-litigates them one at a
// time: Margin, Ship by and the to-list Score are computed per row on the
// client; Impressions and CTR are not in items_full at all; Platforms comes
// from the listing rows joined per item; Buyer holds an opaque id, so ordering
// by it would look sorted while meaning nothing.
function SortHeader({
  field,
  children,
  align = "left",
  columnSort,
  onToggle,
}: {
  field: keyof ItemFullRow;
  children: ReactNode;
  align?: "left" | "right";
  columnSort: ColumnSort;
  onToggle: (field: keyof ItemFullRow) => void;
}) {
  const isActive = columnSort?.field === field;
  return (
    <button
      type="button"
      onClick={() => onToggle(field)}
      className={cn(
        "inline-flex items-center gap-1 font-medium hover:text-foreground",
        align === "right" && "ml-auto",
      )}
    >
      {children}
      {isActive ? (
        columnSort!.dir === "asc" ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )
      ) : (
        <ChevronsUpDown className="h-3 w-3 opacity-50" />
      )}
    </button>
  );
}

export function ListingsTable({
  pageRows,
  tab,
  isActive,
  isDrafts,
  isShipped,
  isSold,
  isToList,
  selectable,
  selected,
  allOnPageSelected,
  toggleSelected,
  toggleSelectAll,
  columnSort,
  toggleColumnSort,
  tableScrollRef,
  virtualize,
  virtualItems,
  rowVirtualizer,
  vPadTop,
  vPadBottom,
  platformsByItem,
  draftMetaByItem,
  publishIssuesByItem,
  coverByItem,
  metricsByItem,
  qualityByListing,
  scoreById,
  buyerCounts,
  updateTracking,
  updateListingPrice,
  updateItemStatus,
  updateItemMoney,
  updateItemNotes,
  markDelivered,
  setPublishItem,
  setMarkListedItem,
  setRecordSaleItem,
  setShipItem,
  setEndTarget,
  setDeleteTarget,
  ebayConnection,
  navigate,
}: Props) {
  // US-9202: which items have an edit that has not reached an extension
  // channel yet. One shared read; the badge says which channel and since when.
  const { data: pendingRevises = [] } = usePendingRevises();
  // US-9203: relist a Poshmark/Mercari/Vinted row by copying it through the
  // extension (or the desktop queue). eBay rows keep their publish dialog.
  const relistExt = useRelistExtension();
  const isExtensionRow = (row: ItemFullRow) =>
    !!row.listing_platform &&
    MARKETPLACE_MECHANISM[row.listing_platform] === "extension" &&
    !!row.listing_id;
  async function relistExtensionRow(row: ItemFullRow) {
    if (!row.listing_id || !row.listing_platform) return;
    try {
      const res = await relistExt.mutateAsync({ listingId: row.listing_id, platform: row.listing_platform });
      if (res.queued) {
        toast.info("Queued for your desktop extension. The old listing is ended once the copy is live.", { duration: 10_000 });
      } else if (res.copied) {
        toast.success("The copy's form is open in a new tab. Review and post it; the old listing is ended once it is live.", { duration: 10_000 });
      } else {
        toast.warning("Copy this listing by hand on the marketplace; the extension could not open the copy.", { duration: 10_000 });
      }
    } catch (err) {
      toastError(err, "Could not start the relist.");
    }
  }
  const staleByItem = new Map<string, { platform: string; label: string }[]>();
  for (const p of pendingRevises) {
    const list = staleByItem.get(p.item_id) ?? [];
    list.push({
      platform: p.platform,
      label: staleSinceLabel(p, MARKETPLACE_LABELS[p.platform as ListingPlatform] ?? p.platform),
    });
    staleByItem.set(p.item_id, list);
  }
  return (
      <div
        ref={tableScrollRef}
        className={cn(
          "hidden overflow-x-auto md:block",
          virtualize && "max-h-[70dvh] overflow-y-auto",
        )}
      >
        <Table className="text-xs">
          <TableHeader
            className={cn(
              virtualize &&
                "sticky top-0 z-10 [&_th]:bg-background",
            )}
          >
            <TableRow>
              {selectable && (
                <TableHead className="w-8 px-2">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5 cursor-pointer"
                    aria-label="Select all on page"
                  />
                </TableHead>
              )}
              <TableHead className="w-10" />
              <TableHead className="w-12 px-1" />
              <TableHead className="min-w-[220px]">
                <SortHeader
                  field="item_title"
                  columnSort={columnSort}
                  onToggle={toggleColumnSort}
                >
                  Title
                </SortHeader>
              </TableHead>
              <TableHead className="w-24">
                <SortHeader
                  field="item_number"
                  columnSort={columnSort}
                  onToggle={toggleColumnSort}
                >
                  SKU
                </SortHeader>
              </TableHead>
              {/* The cell shows brand AND size; the sort is on brand, the one
                  a seller means by "sort by brand". Size is free text
                  ("M", "32x30", "10.5") and sorts as nonsense on its own. */}
              <TableHead className="w-32">
                <SortHeader
                  field="brand"
                  columnSort={columnSort}
                  onToggle={toggleColumnSort}
                >
                  Brand · Size
                </SortHeader>
              </TableHead>
              {isSold ? (
                <>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="sale_price"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Sold $
                    </SortHeader>
                  </TableHead>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="net_profit"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Net
                    </SortHeader>
                  </TableHead>
                  {/* Margin, Ship by and Buyer stay unsorted on purpose — see
                      the note above the header row. */}
                  <TableHead className="w-16 text-right">
                    Margin
                  </TableHead>
                  <TableHead className="w-24">
                    <SortHeader
                      field="payout"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Payout
                    </SortHeader>
                  </TableHead>
                  <TableHead className="w-24">Ship by</TableHead>
                  <TableHead className="w-10">Buyer</TableHead>
                </>
              ) : isToList ? (
                <>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="purchase_price"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Cost
                    </SortHeader>
                  </TableHead>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="target_price"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Target / List
                    </SortHeader>
                  </TableHead>
                  {/* Not sortable: this Score is computed per row on the
                      client (scoreById), so the server has nothing to order
                      by. The Quality column further right IS a real column. */}
                  <TableHead className="w-20 text-right">
                    Score
                  </TableHead>
                </>
              ) : isActive ? (
                <>
                  <TableHead className="w-24 text-right">
                    <SortHeader
                      field="list_price"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Price
                    </SortHeader>
                  </TableHead>
                  <TableHead className="hidden w-16 text-right 2xl:table-cell">
                    <SortHeader
                      field="listing_views"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Views
                    </SortHeader>
                  </TableHead>
                  <TableHead className="hidden w-16 text-right 2xl:table-cell">
                    <SortHeader
                      field="listing_watchers"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Watchers
                    </SortHeader>
                  </TableHead>
                  <TableHead className="hidden w-16 text-right 2xl:table-cell">Impr.</TableHead>
                  <TableHead className="hidden w-16 text-right 2xl:table-cell">CTR</TableHead>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="list_date"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Days listed
                    </SortHeader>
                  </TableHead>
                </>
              ) : isShipped ? (
                <>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="net_profit"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Net
                    </SortHeader>
                  </TableHead>
                  <TableHead className="w-20">
                    <SortHeader
                      field="carrier"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Carrier
                    </SortHeader>
                  </TableHead>
                  <TableHead className="min-w-[150px]">
                    <SortHeader
                      field="tracking"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Tracking
                    </SortHeader>
                  </TableHead>
                  <TableHead className="w-36">
                    <SortHeader
                      field="delivered_at"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Delivery
                    </SortHeader>
                  </TableHead>
                </>
              ) : (
                <>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="purchase_price"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Cost
                    </SortHeader>
                  </TableHead>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="target_price"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Target / List
                    </SortHeader>
                  </TableHead>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="sale_price"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Sale
                    </SortHeader>
                  </TableHead>
                  <TableHead className="w-20 text-right">
                    <SortHeader
                      field="net_profit"
                      align="right"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Net
                    </SortHeader>
                  </TableHead>
                </>
              )}
              <TableHead className="w-24">
                <SortHeader
                  field="status"
                  columnSort={columnSort}
                  onToggle={toggleColumnSort}
                >
                  Status
                </SortHeader>
              </TableHead>
              <TableHead className="hidden min-w-[140px] 2xl:table-cell">
                <SortHeader
                  field="notes"
                  columnSort={columnSort}
                  onToggle={toggleColumnSort}
                >
                  Notes
                </SortHeader>
              </TableHead>
              {(isDrafts || isActive) && (
                <TableHead className="w-28">Platforms</TableHead>
              )}
              {/* US-2170: the Listing Quality Score, next to the other
                  listing-health columns. Sortable now that items_full
                  exposes quality_score (00506) — surfaces the weakest
                  live listings on the Active tab and the weakest drafts,
                  so a seller fixes the lowest scores first. */}
              {(isDrafts || isActive) && (
                <TableHead className="w-20 text-center">
                  <span
                    className="inline-flex"
                    title="Listing Quality Score — 0-100 across every ranking lever"
                  >
                    <SortHeader
                      field="quality_score"
                      columnSort={columnSort}
                      onToggle={toggleColumnSort}
                    >
                      Quality
                    </SortHeader>
                  </span>
                </TableHead>
              )}
              {/* Age is rendered as days-since-updated, so it sorts on the
                  DATE it is derived from. That means the arrow points at the
                  date, not the age: first click is oldest-touched first
                  (highest age). Same shape as "Days listed", which has sorted
                  on list_date since it shipped. */}
              {!isSold && !isActive && (
                <TableHead className="w-16 text-right">
                  <SortHeader
                    field="updated_at"
                    align="right"
                    columnSort={columnSort}
                    onToggle={toggleColumnSort}
                  >
                    Age
                  </SortHeader>
                </TableHead>
              )}
              {isActive && (
                <TableHead className="w-32 text-right">
                  Actions
                </TableHead>
              )}
              {/* US-1568 AC3: draft price / batch / schedule parity. */}
              {tab === "drafts" && (
                <TableHead className="w-40">Draft</TableHead>
              )}
              {tab === "drafts" && (
                <TableHead className="w-32 text-right" />
              )}
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {virtualize && vPadTop > 0 && (
              <tr aria-hidden="true" style={{ height: vPadTop }}>
                <td />
              </tr>
            )}
            {(virtualize
              ? virtualItems.map((vi) => ({
                  it: pageRows[vi.index],
                  measureRef: rowVirtualizer.measureElement,
                  vIndex: vi.index,
                }))
              : pageRows.map((it) => ({
                  it,
                  measureRef: undefined,
                  vIndex: undefined,
                }))
            ).map(({ it, measureRef, vIndex }) => {
              if (!it) return null;
              const age = daysSince(it.updated_at);
              const aging = age != null && age >= 14;
              const score = scoreById.get(it.id) ?? 0;
              const isSel = selected.has(it.id);
              const pay = payoutState(it);
              const ship = shipByInfo(it);
              const m = marginPct(it);
              const repeat =
                it.buyer_id != null &&
                (buyerCounts.get(it.buyer_id) ?? 0) > 1;
              // US-2450: every control in this row is named after this item.
              // Derived ONCE per row rather than per control, so the row cannot
              // introduce itself one way to the checkbox and another way to the
              // price editor.
              const rowLabel = itemRowLabel(it);
              return (
                <ClickableRow
                  key={it.id}
                  ref={measureRef}
                  data-index={vIndex}
                  className={cn(
                    "hover:bg-muted/30",
                    isSel && "bg-brand-navy/5",
                  )}
                  // One editor for every tab. This used to send Drafts to
                  // the composer and everything else to a narrower
                  // canvas that had no eBay specifics editor — which is
                  // how a listed item ended up unable to save (eBay
                  // rejecting the revision for a missing required
                  // specific the seller had no way to fill).
                  onActivate={() =>
                    navigate(`/dashboard/flipdesk/items/${it.id}/draft`)
                  }
                  // Was `it.item_title ?? it.listing_title`, which SKIPPED the
                  // US-1569 placeholder fallback the title cell below applies —
                  // so a row displaying "Nike Windbreaker" announced itself as
                  // "Open Item 42". Same derivation for both now.
                  activateLabel={`Open ${rowLabel}`}
                >
                  {selectable && (
                    <TableCell
                      className="px-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleSelected(it.id)}
                        className="h-3.5 w-3.5 cursor-pointer"
                        aria-label={`Select ${rowLabel}`}
                      />
                    </TableCell>
                  )}
                  <TableCell
                    className="px-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() =>
                        navigate(
                          `/dashboard/flipdesk/items/${it.id}/draft`,
                        )
                      }
                      aria-label={`Open full editor for ${rowLabel}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </TableCell>
                  <TableCell className="px-1">
                    {(() => {
                      const cover = coverByItem?.get(it.id);
                      // US-2273: a private-bucket cover (iOS tag/cert with
                      // an empty photo_url) has no thumbnail but can still
                      // be shown via a signed URL, so admit it here too.
                      const canShow =
                        cover &&
                        (itemPhotoThumb(cover) || needsSignedDisplayUrl(cover));
                      return canShow ? (
                        <ItemPhotoImg
                          photo={cover}
                          displayWidth={40}
                          alt=""
                          loading="lazy"
                          width={40}
                          height={40}
                          className="h-10 w-10 shrink-0 rounded object-cover ring-1 ring-border"
                        />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                          <FileText className="h-4 w-4" />
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="max-w-[280px] font-medium">
                    <div className="flex items-center gap-1.5">
                      {/* US-1569: a placeholder item title falls back
                          to the draft's generated listing title. The rule
                          moved to lib/item-row-label.ts (US-2450) so the
                          control labels apply the same one; the rendered
                          output is unchanged, including the raw (untrimmed)
                          value and the null-renders-nothing case. */}
                      <span className="truncate">{itemDisplayTitle(it)}</span>
                      {tab === "drafts" && it.listing_needs_review && (() => {
                        // US-1568 AC3: show the aspect_review count ("N to
                        // fix") like the AutoLister cockpit, when known.
                        const n = draftMetaByItem?.get(it.id)?.aspectCount ?? 0;
                        return (
                          <Badge
                            variant="outline"
                            className="shrink-0 border-amber-400 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-300"
                            title="The AI flagged fields to double-check before publishing"
                          >
                            {n > 0 ? `${n} to fix` : "Needs review"}
                          </Badge>
                        );
                      })()}
                      {it.grade_value != null && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 px-1.5 py-0 text-[10px]"
                          title={
                            it.grade_label
                              ? `Graded ${it.grade_label}`
                              : "GradeThread grade"
                          }
                        >
                          {Number(it.grade_value).toFixed(1)}
                        </Badge>
                      )}
                      {/* US-9202: never "applied" before the marketplace confirms. */}
                      {(staleByItem.get(it.id) ?? []).map((stale) => (
                        <Badge
                          key={stale.platform}
                          variant="outline"
                          className="shrink-0 border-amber-400 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-300"
                          title="An edit made here has not reached this marketplace yet. The extension applies it, or edit it there."
                        >
                          {stale.label}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[120px] truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                    {it.item_number ?? ""}
                  </TableCell>
                  <TableCell className="max-w-[140px] truncate text-muted-foreground">
                    {[it.brand, it.size].filter(Boolean).join(" · ")}
                  </TableCell>
                  {isSold ? (
                    <>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.sale_price)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          it.net_profit != null &&
                            it.net_profit < 0 &&
                            "text-destructive",
                        )}
                      >
                        {fmtMoney(it.net_profit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {m == null ? "" : `${m.toFixed(0)}%`}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            pay === "cleared"
                              ? "default"
                              : pay === "discrepancy"
                                ? "destructive"
                                : "secondary"
                          }
                          className="text-[10px]"
                        >
                          {pay}
                        </Badge>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          {ship.tone !== "none" && (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 text-[10px] font-medium",
                                ship.tone === "red" &&
                                  "text-destructive",
                                ship.tone === "amber" &&
                                  "text-amber-600 dark:text-amber-400",
                                ship.tone === "green" &&
                                  "text-emerald-600 dark:text-emerald-400",
                              )}
                            >
                              <Truck className="h-3 w-3" />
                              {ship.label}
                            </span>
                          )}
                          {ship.tone !== "green" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[10px]"
                              onClick={() => setShipItem(it)}
                              // The visible words lead the label (WCAG 2.5.3,
                              // label in name) so voice control still activates
                              // it by what is printed on it.
                              aria-label={`Mark shipped: ${rowLabel}`}
                              title="Mark shipped + push tracking to eBay"
                            >
                              Mark shipped
                            </Button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {repeat && (
                          <span
                            title="Repeat buyer"
                            className="text-amber-500"
                          >
                            <Star className="h-3.5 w-3.5 fill-current" />
                          </span>
                        )}
                      </TableCell>
                    </>
                  ) : isToList ? (
                    <>
                      <TableCell
                        className="text-right tabular-nums"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <InlineCell
                          value={it.purchase_price}
                          label="Cost"
                          rowLabel={rowLabel}
                          type="number"
                          align="right"
                          onChange={(v) =>
                            updateItemMoney(
                              it,
                              v,
                              "acquired_price",
                              "purchase_price",
                              "Cost",
                            )
                          }
                        />
                      </TableCell>
                      <TableCell
                        className="text-right tabular-nums"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <InlineCell
                          value={it.target_price}
                          label="Target price"
                          rowLabel={rowLabel}
                          type="number"
                          align="right"
                          onChange={(v) =>
                            updateItemMoney(
                              it,
                              v,
                              "target_price",
                              "target_price",
                              "Target",
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            "font-mono font-semibold tabular-nums",
                            scoreColor(score),
                          )}
                        >
                          {score}
                        </span>
                      </TableCell>
                    </>
                  ) : isActive ? (
                    <>
                      <TableCell
                        className="text-right tabular-nums"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <InlineCell
                          value={it.list_price}
                          label="List price"
                          rowLabel={rowLabel}
                          type="number"
                          align="right"
                          onChange={(v) => updateListingPrice(it, v)}
                        />
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground 2xl:table-cell">
                        {it.listing_views ?? "—"}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground 2xl:table-cell">
                        {it.listing_watchers ?? "—"}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground 2xl:table-cell">
                        {metricsByItem?.get(it.id)?.impressions?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground 2xl:table-cell">
                        {(() => {
                          const ctr = metricsByItem?.get(it.id)?.ctr;
                          return ctr == null ? "—" : `${(ctr * 100).toFixed(1)}%`;
                        })()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {daysSince(it.list_date) ?? "—"}
                      </TableCell>
                    </>
                  ) : isShipped ? (
                    <>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          it.net_profit != null &&
                            it.net_profit < 0 &&
                            "text-destructive",
                        )}
                      >
                        {fmtMoney(it.net_profit)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {it.carrier ?? "—"}
                      </TableCell>
                      <TableCell
                        className="font-mono text-[11px]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <InlineCell
                          value={it.tracking}
                          label="Tracking number"
                          rowLabel={rowLabel}
                          type="text"
                          placeholder="Add tracking"
                          onChange={(v) => updateTracking(it, v)}
                        />
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {it.delivered_at ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" />
                            Delivered{" "}
                            {new Date(
                              it.delivered_at,
                            ).toLocaleDateString()}
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => markDelivered(it)}
                            aria-label={`Mark delivered: ${rowLabel}`}
                            title="Mark this order delivered"
                          >
                            Mark delivered
                          </Button>
                        )}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell
                        className="text-right tabular-nums"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <InlineCell
                          value={it.purchase_price}
                          label="Cost"
                          rowLabel={rowLabel}
                          type="number"
                          align="right"
                          onChange={(v) =>
                            updateItemMoney(
                              it,
                              v,
                              "acquired_price",
                              "purchase_price",
                              "Cost",
                            )
                          }
                        />
                      </TableCell>
                      <TableCell
                        className="text-right tabular-nums"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <InlineCell
                          value={it.target_price}
                          label="Target price"
                          rowLabel={rowLabel}
                          type="number"
                          align="right"
                          onChange={(v) =>
                            updateItemMoney(
                              it,
                              v,
                              "target_price",
                              "target_price",
                              "Target",
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.sale_price)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          it.net_profit != null &&
                            it.net_profit < 0 &&
                            "text-destructive",
                        )}
                      >
                        {fmtMoney(it.net_profit)}
                      </TableCell>
                    </>
                  )}
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <InlineStatusSelect
                      value={it.status}
                      rowLabel={rowLabel}
                      onChange={(next) => updateItemStatus(it, next)}
                    />
                  </TableCell>
                  <TableCell
                    className="hidden max-w-[220px] text-muted-foreground 2xl:table-cell"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <InlineCell
                      value={it.notes}
                      label="Notes"
                      rowLabel={rowLabel}
                      type="text"
                      placeholder="Add notes"
                      truncate
                      onChange={(v) => updateItemNotes(it, v)}
                    />
                  </TableCell>
                  {(isDrafts || isActive) && (
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(platformsByItem?.get(it.id) ?? []).map(
                          (l) => (
                            <span
                              key={l.id}
                              className="inline-flex items-center gap-0.5"
                            >
                              <span
                                title={`${MARKETPLACE_LABELS[l.platform]} — ${l.status}`}
                                className={cn(
                                  "rounded border px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                                  l.status === "active"
                                    ? "border-emerald-400/60 text-emerald-600 dark:text-emerald-400"
                                    : l.status === "sold"
                                      ? "border-brand-navy/40 text-brand-navy dark:text-foreground"
                                      : "text-muted-foreground",
                                )}
                              >
                                {MARKETPLACE_LABELS[l.platform]}
                              </span>
                              {/* Provenance tag (US-1077/US-1081): only eBay
                                  listings have a meaningful origin — who owns
                                  the fields and which way sync flows. */}
                              {l.platform === "ebay" && (
                                <span
                                  title={
                                    l.origin === "ebay"
                                      ? "Created on eBay — eBay owns the fields; edit on eBay"
                                      : "Created in GradeThread — source of truth; edit here"
                                  }
                                  className={cn(
                                    "rounded border px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                                    l.origin === "ebay"
                                      ? "border-amber-400/60 text-amber-600 dark:text-amber-400"
                                      : "border-brand-navy/40 text-brand-navy dark:text-foreground",
                                  )}
                                >
                                  {l.origin === "ebay" ? "eBay-made" : "GT"}
                                </span>
                              )}
                            </span>
                          ),
                        )}
                      </div>
                    </TableCell>
                  )}
                  {/* US-2170: quality chip. Renders an em dash for an
                      unscored listing — never a 0, which would read as a
                      confident "this is terrible" for a listing nobody
                      has run a publish check on. */}
                  {(isDrafts || isActive) && (
                    <TableCell className="text-center">
                      <QualityScoreChip
                        score={
                          it.listing_id
                            ? qualityByListing[it.listing_id]
                            : undefined
                        }
                      />
                    </TableCell>
                  )}
                  {!isSold && !isActive && (
                    <TableCell className="text-right">
                      {age != null && (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 tabular-nums",
                            aging
                              ? "font-medium text-destructive"
                              : "text-muted-foreground",
                          )}
                        >
                          {aging ? (
                            <AlertCircle className="h-3 w-3" />
                          ) : (
                            <Clock className="h-3 w-3" />
                          )}
                          {age}d
                        </span>
                      )}
                    </TableCell>
                  )}
                  {isActive && (
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-end gap-1">
                        {ebayConnection && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => setPublishItem(it)}
                            aria-label={`Relist ${rowLabel} as a new listing`}
                            title="End this listing and relist as a new one"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {/* US-9203: a live extension-channel row relists by copying. */}
                        {isExtensionRow(it) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={relistExt.isPending}
                            onClick={() => void relistExtensionRow(it)}
                            aria-label={`Relist ${rowLabel} by copying it`}
                            title="Copy this listing into a fresh one; the old one is ended once the copy is live"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => setRecordSaleItem(it)}
                          aria-label={`Sold: record the sale of ${rowLabel}`}
                        >
                          Sold
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive"
                          onClick={() => setEndTarget(it)}
                          aria-label={`End the listing for ${rowLabel} early`}
                          title="End listing early"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                  {tab === "drafts" && (() => {
                    // US-1568 AC3: the draft's generated price (+ "est."
                    // badge), batch link, and scheduled-drop date — the
                    // listing-level info the AutoLister cockpit shows.
                    const dm = draftMetaByItem?.get(it.id);
                    const price = dm?.listingPrice ?? it.list_price;
                    return (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col items-start gap-0.5 text-[11px]">
                          <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                            {price != null ? `$${price.toFixed(2)}` : "—"}
                            {dm?.priceIsEstimated && (
                              <Badge
                                variant="outline"
                                className="px-1 py-0 text-[9px]"
                                title={
                                  dm.priceCompSource === "active_asking"
                                    ? "Based on active asking prices (not sold comps) — may run high. Verify before publishing."
                                    : "AI estimate — verify before publishing"
                                }
                              >
                                est.
                              </Badge>
                            )}
                          </span>
                          {dm?.scheduledPublishAt && (
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              <CalendarClock className="h-3 w-3" />
                              {new Date(dm.scheduledPublishAt).toLocaleDateString()}
                            </span>
                          )}
                          {dm?.batchId && (
                            <Link
                              to={`/dashboard/flipdesk/autolister/queue?batch=${dm.batchId}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-brand-red-text hover:underline"
                              aria-label={`Open the AutoLister batch for ${rowLabel}`}
                              title="Open this batch (publish all / bulk edit)"
                            >
                              <Layers className="h-3 w-3" /> Queue
                            </Link>
                          )}
                        </div>
                      </TableCell>
                    );
                  })()}
                  {tab === "drafts" && (
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-end gap-1">
                        {(() => {
                          const issue = publishIssuesByItem?.get(it.id);
                          return issue ? (
                            <span
                              title={issue}
                              className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                            >
                              <AlertTriangle className="h-3 w-3" />
                              eBay inactive — review &amp; relist
                            </span>
                          ) : null;
                        })()}
                        {(() => {
                          const isRelist = it.listing_status === "ended";
                          // US-9203: an ended extension-channel row relists by
                          // copying through the extension, not the eBay dialog.
                          if (isRelist && isExtensionRow(it)) {
                            return (
                              <Button
                                size="sm"
                                className="h-6 px-2 text-[10px]"
                                disabled={relistExt.isPending}
                                onClick={() => void relistExtensionRow(it)}
                                aria-label={`Relist: ${rowLabel}`}
                                title="Copy this listing into a fresh one through the extension; the old one is ended once the copy is live"
                              >
                                <RotateCcw className="mr-1 h-3 w-3" />
                                Relist
                              </Button>
                            );
                          }
                          if (ebayConnection) {
                            return (
                              <>
                                <Button
                                  size="sm"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={() => setPublishItem(it)}
                                  aria-label={`${isRelist ? "Relist" : "Publish"}: ${rowLabel}`}
                                  title={
                                    isRelist
                                      ? "Republish to eBay (same SKU, new listing)"
                                      : undefined
                                  }
                                >
                                  {isRelist ? (
                                    <RotateCcw className="mr-1 h-3 w-3" />
                                  ) : (
                                    <Rocket className="mr-1 h-3 w-3" />
                                  )}
                                  {isRelist ? "Relist" : "Publish"}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={() => setMarkListedItem(it)}
                                  aria-label={`Mark ${rowLabel} as already listed`}
                                  title="Skip eBay API — just record that it's live"
                                >
                                  Mark
                                </Button>
                              </>
                            );
                          }
                          return (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[10px]"
                              onClick={() => setMarkListedItem(it)}
                              aria-label={`${isRelist ? "Relist" : "List it"}: ${rowLabel}`}
                            >
                              {isRelist ? "Relist" : "List it"}
                            </Button>
                          );
                        })()}
                      </div>
                    </TableCell>
                  )}
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      {it.link && (
                        <a
                          href={it.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex text-brand-red-text"
                          aria-label={`Open the marketplace listing for ${rowLabel}`}
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {/* Delete a duplicate item. Hidden on terminal
                          accounting tabs (sold/shipped/returned) where a
                          hard delete is never appropriate; the server
                          still guards live listings + any sale. */}
                      {!isSold && !isShipped && tab !== "returned" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(it)}
                          aria-label={`Delete ${rowLabel}`}
                          title="Delete this item and its photos (for removing a duplicate)"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </ClickableRow>
              );
            })}
            {virtualize && vPadBottom > 0 && (
              <tr aria-hidden="true" style={{ height: vPadBottom }}>
                <td />
              </tr>
            )}
          </TableBody>
        </Table>
      </div>
  );
}
