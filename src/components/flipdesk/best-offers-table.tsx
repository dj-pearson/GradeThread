// US-3297: Best Offers as a sortable table with an expandable detail row.
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
//
// A stack of bordered divs, one per offer, each carrying five lines of prose:
// title, buyer and price, the economics sentence, the buyer-history sentence,
// the quoted message. About 140px of vertical space per offer, in whatever
// order eBay returned them. Fifteen offers filled two and a half screens and
// the only way to find the one expiring first was to read all of them.
//
// The table gives one row per offer with the six figures that decide it, sorted
// by expiry, and puts everything else — the buyer's note, their history, the
// full cost breakdown, the counter form — one click down in a detail row. The
// information did not shrink; it stopped being in the way of the next offer.
//
// ── WHY A DETAIL ROW AND NOT A DIALOG ───────────────────────────────────────
//
// Countering is a comparison: the seller is deciding this price against the
// asking price and against the other offers on the same item. A modal covers
// the table it is being compared with. The detail row keeps the rest of the
// list on screen and the arithmetic beside the input.
//
// ── MOBILE ──────────────────────────────────────────────────────────────────
//
// Seven columns do not fit a phone, so under `md` this renders a card list, the
// same split listings.tsx uses. The cards and the rows share every sub-component
// below the summary line, so the detail panel, the counter form and the actions
// cannot drift between the two.

// ── OM-05..08, OM-15 ────────────────────────────────────────────────────────
//
// Closed offers keep their row but lose their buttons. Accepting at a loss and
// every decline ask first, with the dollar figure in the question. A counter is
// checked against the bid and the asking price before Send is enabled, and the
// quick-counter chips price it from what the seller keeps. Unsent counters live
// with the panel (use-session-drafts.ts), so collapsing a row, opening another
// or crossing the md breakpoint no longer throws them away.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useSearchParams } from "react-router";
import { useFocusParam } from "@/hooks/use-focus-param";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquareQuote,
  Reply,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pager,
  SortHeader,
  TableFilter,
} from "@/components/flipdesk/negotiation-table-parts";
import {
  resolveInventoryItemIdForEbayItem,
  useEbayBestOffers,
  useEbayRespondOffer,
  useEbayThresholdConflicts,
  type EbayBestOffer,
  type EdgeError,
} from "@/hooks/use-ebay";
import { useTenantKey } from "@/hooks/use-tenant-key";
import { useSessionDrafts } from "@/hooks/use-session-drafts";
import { useNegotiationDraft } from "@/hooks/use-ai-extract";
import { applyNegotiationDraft } from "@/pages/flipdesk/negotiation-draft-prefill";
import {
  formatMoney,
  grossMarginCents,
  marginPct,
  netMarginCents,
  netMarginPct,
  pctOfList,
  quickCounters,
  readExpiry,
  validateCounter,
  type CounterRule,
} from "@/pages/flipdesk/offer-economics";
import {
  DEFAULT_OFFER_SORT,
  filterOffers,
  isOpenOffer,
  naturalOfferDir,
  nextSort,
  offerEconomics,
  sortOffers,
  type OfferSort,
  type OfferSortField,
} from "@/pages/flipdesk/offers-sort";
import { SELLER_RESPONSE_MAX } from "@/lib/offer-limits";
import { ebayFeesFor } from "@/lib/ebay-fees";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

// US-2494: the AI drafter reads the local inventory item (title, asking price,
// cost), so an offer on a listing FlipDesk never imported has nothing to draft
// from.
const NO_LOCAL_ITEM =
  "This listing isn't linked to a FlipDesk item, so there's nothing for the draft to read.";

const NOT_OPEN_COPY =
  "This offer is no longer open. It may have expired or already been answered.";

/** OM-08: one offer's unsent counter, held by the panel rather than the row. */
export interface OfferDraft {
  price: string;
  note: string;
  warnings: string[];
}

const EMPTY_DRAFT: OfferDraft = { price: "", note: "", warnings: [] };

function hasText(d: OfferDraft | undefined): boolean {
  return !!d && (d.price.trim() !== "" || d.note.trim() !== "");
}

/** What the panel hands each row so the row, the card and the detail share one draft. */
interface DraftSlot {
  value: OfferDraft;
  set: (next: OfferDraft) => void;
  clear: () => void;
}

export function BestOffersPanel() {
  const {
    data: offers = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useEbayBestOffers();
  // OM-15: the seller's own rule, when one is active, sets the floor chip.
  // The same query the conflict banner above this table already runs.
  const { data: conflictReport } = useEbayThresholdConflicts();
  const rule: CounterRule | null = conflictReport?.rule
    ? {
        acceptAtPct: conflictReport.rule.accept_at_pct,
        marginFloorPct: conflictReport.rule.margin_floor_pct,
      }
    : null;
  const drafts = useSessionDrafts<OfferDraft>("offer-drafts");

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<OfferSort>(DEFAULT_OFFER_SORT);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  // OM-05: closed offers (answered, expired, retracted) sort after every open
  // one and only show on request. They used to sit in the list with live
  // Accept buttons, and the header counted them as waiting.
  const { openRows, closedRows } = useMemo(() => {
    const sorted = sortOffers(filterOffers(offers, query), sort);
    return {
      openRows: sorted.filter((o) => isOpenOffer(o)),
      closedRows: sorted.filter((o) => !isOpenOffer(o)),
    };
  }, [offers, query, sort]);
  const rows = showClosed ? [...openRows, ...closedRows] : openRows;
  const openCount = useMemo(() => offers.filter((o) => isOpenOffer(o)).length, [offers]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // Typing in the filter while on page 3 of the old result set would otherwise
  // land on an empty page, which reads as "no matches".
  useEffect(() => {
    setPage(0);
  }, [query, sort, showClosed]);

  // OM-08: a draft for an offer that has left the list is nobody's draft.
  const { retain } = drafts;
  useEffect(() => {
    if (isLoading || error) return;
    retain(offers.map((o) => o.bestOfferId));
  }, [offers, isLoading, error, retain]);

  // DASH-15: `?focus=<bestOfferId>` from a Needs-you row. Turn to the page the
  // offer is on and open it; useFocusParam then scrolls to it and focuses it.
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get("focus");
  const focusIndex = focusId ? rows.findIndex((o) => o.bestOfferId === focusId) : -1;
  const focusPage = focusIndex >= 0 ? Math.floor(focusIndex / PAGE_SIZE) : null;
  // Once per focus id. Re-running on every focusPage change would yank the
  // seller back to the offer each time they sort, search or page away.
  const turnedFor = useRef<string | null>(null);
  useEffect(() => {
    if (focusPage == null || !focusId || turnedFor.current === focusId) return;
    turnedFor.current = focusId;
    setPage(focusPage);
    setExpanded(focusId);
  }, [focusPage, focusId]);
  useFocusParam({
    ready: !isLoading,
    known: focusPage != null && focusPage === safePage,
  });
  const focusMissing = !!focusId && !isLoading && !error && focusIndex < 0;

  function toggleSort(field: OfferSortField) {
    setSort((s) => nextSort(s, field, naturalOfferDir(field)));
  }

  function toggleExpanded(id: string) {
    setExpanded((cur) => (cur === id ? null : id));
  }

  function slotFor(id: string): DraftSlot {
    return {
      value: drafts.get(id) ?? EMPTY_DRAFT,
      set: (next) => drafts.set(id, next),
      clear: () => drafts.clear(id),
    };
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Tag className="h-4 w-4 text-brand-red-text" />
          Best Offers
          {openCount > 0 && (
            <Badge
              variant="secondary"
              className="ml-1 tabular-nums"
              aria-label={`${openCount} open`}
            >
              {openCount.toLocaleString()}
            </Badge>
          )}
        </CardTitle>
        {offers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <TableFilter
              value={query}
              onChange={setQuery}
              label="Filter offers"
              placeholder="Filter by item or buyer"
            />
            {query && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {rows.length.toLocaleString()} of {offers.length.toLocaleString()}
              </span>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {focusMissing ? (
          <p className="text-sm text-muted-foreground" role="status">
            {NOT_OPEN_COPY}
          </p>
        ) : null}
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : error ? (
          <ErrorState
            className="py-6"
            hideSupport
            title="Couldn't load offers"
            description={(error as Error).message}
            onRetry={() => refetch()}
            retrying={isFetching}
          />
        ) : offers.length === 0 || (rows.length === 0 && !query) ? (
          <EmptyState
            icon={Tag}
            title="No open offers"
            description="When a buyer offers less than your asking price, it lands here with a drafted reply. Nothing is sent until you send it."
            action={{
              label: "Check your listings",
              to: "/dashboard/flipdesk/inventory",
            }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={Tag}
            title="No offers match that"
            description="Clear the filter to see every open offer."
          />
        ) : (
          <>
            {/* Phones: the seven columns do not fit, so the same rows render as
                cards. Everything below the summary line is shared. */}
            <div className="space-y-2 md:hidden">
              {pageRows.map((offer) => (
                <OfferCard
                  key={offer.bestOfferId}
                  offer={offer}
                  open={expanded === offer.bestOfferId}
                  onToggle={() => toggleExpanded(offer.bestOfferId)}
                  draft={slotFor(offer.bestOfferId)}
                  rule={rule}
                />
              ))}
            </div>

            <div className="hidden rounded-md border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <SortHeader field="item" sort={sort} onSort={toggleSort}>
                      Item
                    </SortHeader>
                    <TableHead>Buyer</TableHead>
                    <SortHeader
                      field="offer"
                      align="right"
                      sort={sort}
                      onSort={toggleSort}
                    >
                      Offer
                    </SortHeader>
                    <SortHeader
                      field="share"
                      align="right"
                      sort={sort}
                      onSort={toggleSort}
                    >
                      % of ask
                    </SortHeader>
                    <SortHeader
                      field="net"
                      align="right"
                      sort={sort}
                      onSort={toggleSort}
                    >
                      Net
                    </SortHeader>
                    <SortHeader field="expires" sort={sort} onSort={toggleSort}>
                      Expires
                    </SortHeader>
                    <TableHead className="text-right">Respond</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((offer) => (
                    <OfferRows
                      key={offer.bestOfferId}
                      offer={offer}
                      open={expanded === offer.bestOfferId}
                      onToggle={() => toggleExpanded(offer.bestOfferId)}
                      draft={slotFor(offer.bestOfferId)}
                      rule={rule}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            <Pager
              page={safePage}
              pageCount={pageCount}
              total={rows.length}
              noun={rows.length === 1 ? "offer" : "offers"}
              onPage={setPage}
            />
          </>
        )}
        {!isLoading && !error && closedRows.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground"
            aria-pressed={showClosed}
            onClick={() => setShowClosed((v) => !v)}
          >
            {showClosed ? "Hide closed offers" : `Show ${closedRows.length} closed`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ── responding ──────────────────────────────────────────────────────────────

type RespondAction = "Accept" | "Decline" | "Counter";

/**
 * Accept, decline and counter for one offer.
 *
 * Created ONCE per offer, by the row (or the phone card), and handed to both
 * the button group and the detail panel. One mutation means one pending flag,
 * so a seller cannot press Accept while their counter on the same offer is
 * still in flight — two calls to this hook would give the two halves of the
 * row separate `busy` states that each think the other is idle.
 *
 * OM-05: an accepted or declined offer leaves the cached list the moment eBay
 * says yes, rather than staying live until the refetch lands, which is how
 * Accept could be pressed twice. A 409 offer_not_open does the same with a
 * neutral message: the offer was already over, and the row was the stale part.
 */
function useOfferResponse(offer: EbayBestOffer) {
  const qc = useQueryClient();
  const tenantKey = useTenantKey();
  const respond = useEbayRespondOffer();

  function removeRow() {
    qc.setQueryData<EbayBestOffer[]>(["ebay_best_offers", tenantKey], (old) =>
      old?.filter((o) => o.bestOfferId !== offer.bestOfferId),
    );
  }

  async function act(action: RespondAction, counterPrice?: number, message?: string) {
    try {
      await respond.mutateAsync({
        bestOfferId: offer.bestOfferId,
        itemId: offer.itemId,
        action,
        counterPrice: action === "Counter" ? counterPrice : undefined,
        // OM-07: a counter on a x3 offer is a counter on three.
        counterQuantity: action === "Counter" ? (offer.quantity ?? 1) : undefined,
        message: action === "Counter" ? message : undefined,
      });
      if (action !== "Counter") removeRow();
      toast.success(
        action === "Accept"
          ? "Offer accepted."
          : action === "Decline"
            ? "Offer declined."
            : "Counter offer sent.",
      );
      void qc.invalidateQueries({ queryKey: ["ebay_best_offers"] });
      return true;
    } catch (err) {
      const e = err as EdgeError;
      if (e.code === "offer_not_open" || e.status === 409) {
        removeRow();
        toast(NOT_OPEN_COPY);
        void qc.invalidateQueries({ queryKey: ["ebay_best_offers"] });
        return false;
      }
      toastError(err, "Couldn't respond.");
      return false;
    }
  }

  // OM-05: which button is working, so only that one spins.
  const pendingAction: RespondAction | null = respond.isPending
    ? (respond.variables?.action ?? null)
    : null;
  return { act, busy: respond.isPending, pendingAction };
}

type OfferResponse = ReturnType<typeof useOfferResponse>;

function offerPriceLabel(offer: EbayBestOffer): string {
  return offer.price != null
    ? formatMoney(Math.round(offer.price * 100), offer.currency ?? "USD")
    : "this offer";
}

/**
 * OM-06: the sentence under "Accepting loses $4.10". The same lines as the
 * detail panel's breakdown, so the confirm and the panel cannot disagree.
 */
function acceptBreakdown(offer: EbayBestOffer): string {
  const cur = offer.currency ?? "USD";
  if (offer.price == null) return "Accepting is a binding sale.";
  if (netMarginCents(offerEconomics(offer)) == null) {
    return `This item has no cost on record, so we can't tell whether ${offerPriceLabel(
      offer,
    )} covers it after eBay's fees and postage. Accepting is a binding sale.`;
  }
  return `${costLines(offer)
    .map(([label, cents]) => `${label} ${formatMoney(cents, cur)}`)
    .join(". ")}. Accepting is a binding sale.`;
}

function OfferActions({
  offer,
  respond,
  onCounter,
  size = "sm",
}: {
  offer: EbayBestOffer;
  respond: OfferResponse;
  onCounter: () => void;
  size?: "sm" | "default";
}) {
  const confirm = useConfirm();
  const { act, busy, pendingAction } = respond;
  const cur = offer.currency ?? "USD";
  const net = netMarginCents(offerEconomics(offer));

  // OM-06: a profitable accept is one click. A loss, or an unknown cost, asks
  // first and says the dollar figure in the question.
  async function accept() {
    if (net != null && net >= 0) {
      await act("Accept");
      return;
    }
    const ok = await confirm({
      title:
        net == null
          ? "We don't know this item's cost"
          : `Accepting loses ${formatMoney(-net, cur)} after fees and postage`,
      description: acceptBreakdown(offer),
      confirmLabel: "Accept offer",
      destructive: true,
    });
    if (ok) await act("Accept");
  }

  // OM-06: a decline is immediate and final on eBay, so it always asks. A
  // confirm rather than an undo toast, because the call cannot be held back.
  async function decline() {
    const ok = await confirm({
      title: `Decline ${offerPriceLabel(offer)}${
        offer.buyerUsername ? ` from ${offer.buyerUsername}` : " from this buyer"
      }?`,
      description: "This can't be undone. eBay tells the buyer right away.",
      confirmLabel: "Decline offer",
      destructive: true,
    });
    if (ok) await act("Decline");
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button size={size} className="h-8" disabled={busy} onClick={accept}>
        {pendingAction === "Accept" ? (
          <>
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Accepting...
          </>
        ) : (
          <>
            <Check className="mr-1 h-3.5 w-3.5" /> Accept
          </>
        )}
      </Button>
      <Button
        size={size}
        variant="outline"
        className="h-8"
        disabled={busy}
        onClick={onCounter}
      >
        {pendingAction === "Counter" ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Reply className="mr-1 h-3.5 w-3.5" />
        )}
        Counter
      </Button>
      <Button
        size={size}
        variant="ghost"
        className="h-8 text-destructive"
        disabled={busy}
        onClick={decline}
      >
        {pendingAction === "Decline" ? (
          <>
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Declining...
          </>
        ) : (
          <>
            <X className="mr-1 h-3.5 w-3.5" /> Decline
          </>
        )}
      </Button>
    </div>
  );
}

/** OM-05: what a finished offer shows where its buttons were. */
function ClosedLabel({ offer }: { offer: EbayBestOffer }) {
  const expired =
    offer.status?.toLowerCase() === "expired" ||
    readExpiry(offer.expiresAt)?.urgency === "expired";
  return (
    <span className="text-xs text-muted-foreground">
      {expired ? "Expired" : offer.status || "Closed"}
    </span>
  );
}

// ── summary cells ───────────────────────────────────────────────────────────

function ExpiryBadge({ offer }: { offer: EbayBestOffer }) {
  // Re-read on every render rather than memoized: the row re-renders on the
  // 90-second background refetch, which is exactly when the countdown should
  // move. Memoizing would freeze the clock until the offer changed.
  const expiry = readExpiry(offer.expiresAt);
  if (!expiry) return <span className="text-muted-foreground">—</span>;
  const urgent =
    expiry.urgency === "expired" || expiry.urgency === "last_hours";
  return (
    <Badge
      variant={urgent ? "destructive" : "outline"}
      className="text-xs font-normal"
      title={offer.expiresAt ? new Date(offer.expiresAt).toLocaleString() : undefined}
    >
      {expiry.label}
    </Badge>
  );
}

function NetCell({ offer }: { offer: EbayBestOffer }) {
  const cur = offer.currency ?? "USD";
  const net = netMarginCents(offerEconomics(offer));
  const share = netMarginPct(offerEconomics(offer));
  if (net == null) {
    return (
      <span className="text-xs text-muted-foreground">cost unknown</span>
    );
  }
  return (
    <span
      className={cn(
        "tabular-nums",
        net < 0 ? "font-medium text-destructive" : "font-medium",
      )}
    >
      {formatMoney(net, cur)}
      {share != null && (
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          {share}%
        </span>
      )}
    </span>
  );
}

/** OM-08: a collapsed row with unsent text says so. */
function DraftChip() {
  return (
    <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-xs font-normal">
      Draft
    </Badge>
  );
}

// ── the desktop row pair ────────────────────────────────────────────────────

/**
 * Returns TWO `tr`s: the summary and, when open, the detail.
 *
 * A fragment rather than a nested table because a `tr` inside a `td` is not a
 * table row as far as the browser is concerned — the columns stop lining up and
 * keyboard navigation over the grid breaks.
 */
function OfferRows({
  offer,
  open,
  onToggle,
  draft,
  rule,
}: {
  offer: EbayBestOffer;
  open: boolean;
  onToggle: () => void;
  draft: DraftSlot;
  rule: CounterRule | null;
}) {
  const cur = offer.currency ?? "USD";
  const share = pctOfList(offerEconomics(offer));
  const detailRef = useRef<HTMLInputElement>(null);
  const respond = useOfferResponse(offer);
  const live = isOpenOffer(offer);

  function openAndFocusCounter() {
    if (!open) onToggle();
    // The input only exists once the detail row is mounted, so focus lands on
    // the next tick either way.
    setTimeout(() => detailRef.current?.focus(), 0);
  }

  return (
    <>
      <TableRow
        className={cn(
          "cursor-pointer align-top data-[focused=true]:ring-2 data-[focused=true]:ring-primary focus-visible:outline-none",
          !live && "text-muted-foreground",
        )}
        data-focus-id={offer.bestOfferId}
        data-state={open ? "selected" : undefined}
        onClick={onToggle}
      >
        <TableCell className="pr-0">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide offer detail" : "Show offer detail"}
            className="text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {open ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </TableCell>
        <TableCell className="max-w-[22rem] whitespace-normal">
          <span className="line-clamp-2 text-sm font-medium">
            {offer.itemTitle || offer.itemId}
          </span>
          {offer.status && (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {offer.status}
              {!open && live && hasText(draft.value) && <DraftChip />}
            </span>
          )}
          {!offer.status && !open && live && hasText(draft.value) && <DraftChip />}
        </TableCell>
        <TableCell className="text-sm">
          {offer.buyerUsername || "—"}
          {/* Buyer memory: same person, third offer, second item. A chip rather
              than the old sentence, because the sentence was longer than the
              row it explained. */}
          {offer.buyerHistory && offer.buyerHistory.priorOffers > 0 && (
            <Badge
              variant="secondary"
              className="ml-1.5 px-1.5 py-0 text-[10px] font-normal tabular-nums"
            >
              {offer.buyerHistory.priorOffers}x before
            </Badge>
          )}
          {offer.message && (
            <MessageSquareQuote
              className="ml-1.5 inline h-3.5 w-3.5 text-muted-foreground"
              aria-label="This buyer left a note"
            />
          )}
        </TableCell>
        <TableCell className="text-right font-medium tabular-nums">
          {offer.price != null ? `${cur === "USD" ? "$" : `${cur} `}${offer.price.toFixed(2)}` : "—"}
          {offer.quantity && offer.quantity > 1 ? (
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              x{offer.quantity}
            </span>
          ) : null}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {share != null ? (
            `${share}%`
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="text-right">
          <NetCell offer={offer} />
        </TableCell>
        <TableCell>
          <ExpiryBadge offer={offer} />
        </TableCell>
        <TableCell
          className="text-right"
          onClick={(e) => e.stopPropagation()}
        >
          {live ? (
            <OfferActions offer={offer} respond={respond} onCounter={openAndFocusCounter} />
          ) : (
            <ClosedLabel offer={offer} />
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={8} className="whitespace-normal p-4">
            <OfferDetail
              offer={offer}
              respond={respond}
              priceRef={detailRef}
              draft={draft}
              rule={rule}
              live={live}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ── the phone card ──────────────────────────────────────────────────────────

function OfferCard({
  offer,
  open,
  onToggle,
  draft,
  rule,
}: {
  offer: EbayBestOffer;
  open: boolean;
  onToggle: () => void;
  draft: DraftSlot;
  rule: CounterRule | null;
}) {
  const cur = offer.currency ?? "USD";
  const share = pctOfList(offerEconomics(offer));
  const priceRef = useRef<HTMLInputElement>(null);
  const respond = useOfferResponse(offer);
  const live = isOpenOffer(offer);

  function openAndFocusCounter() {
    if (!open) onToggle();
    setTimeout(() => priceRef.current?.focus(), 0);
  }

  return (
    <div className="rounded-md border data-[focused=true]:ring-2 data-[focused=true]:ring-primary focus-visible:outline-none" data-focus-id={offer.bestOfferId}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full p-3 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="line-clamp-2 text-sm font-medium">
            {offer.itemTitle || offer.itemId}
            {!open && live && hasText(draft.value) && <DraftChip />}
          </span>
          <ExpiryBadge offer={offer} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {offer.buyerUsername ? `${offer.buyerUsername} · ` : ""}
          <span className="font-medium text-foreground tabular-nums">
            {offer.price != null
              ? `${cur === "USD" ? "$" : `${cur} `}${offer.price.toFixed(2)}`
              : "—"}
          </span>
          {share != null ? ` · ${share}% of ask` : ""}
        </p>
        <p className="mt-0.5 text-xs">
          <NetCell offer={offer} />
        </p>
      </button>
      <div className="px-3 pb-3">
        {live ? (
          <OfferActions offer={offer} respond={respond} onCounter={openAndFocusCounter} />
        ) : (
          <ClosedLabel offer={offer} />
        )}
      </div>
      {open && (
        <div className="border-t bg-muted/30 p-3">
          <OfferDetail
            offer={offer}
            respond={respond}
            priceRef={priceRef}
            draft={draft}
            rule={rule}
            live={live}
          />
        </div>
      )}
    </div>
  );
}

// ── the detail panel ────────────────────────────────────────────────────────

/**
 * Everything the summary row left out, plus the counter form.
 *
 * The cost breakdown is here rather than on the row on purpose: the row answers
 * "is this worth taking", which is one number, and the breakdown answers "why is
 * it only that much", which is five. Putting the second on every row is what
 * made the old list 140px tall per offer.
 */
function OfferDetail({
  offer,
  respond,
  priceRef,
  draft,
  rule,
  live,
}: {
  offer: EbayBestOffer;
  respond: OfferResponse;
  priceRef: RefObject<HTMLInputElement | null>;
  draft: DraftSlot;
  rule: CounterRule | null;
  live: boolean;
}) {
  const { act, busy, pendingAction } = respond;
  const ai = useNegotiationDraft();
  const { price, note, warnings } = draft.value;
  const cur = offer.currency ?? "USD";
  const economics = offerEconomics(offer);
  const gross = grossMarginCents(economics);
  const grossShare = marginPct(economics);
  const check = validateCounter(offer, price);
  const chips = useMemo(() => quickCounters(offer, rule), [offer, rule]);
  const reasonId = `counter-reason-${offer.bestOfferId}`;
  const noteCountId = `counter-note-count-${offer.bestOfferId}`;

  function patch(next: Partial<OfferDraft>) {
    draft.set({ ...draft.value, ...next });
  }

  // US-2494: one AI action per press, so this only ever runs from the button.
  // The offer carries eBay's item id; the drafter needs the local row's UUID.
  async function draftCounter() {
    let itemId: string | null;
    try {
      itemId = await resolveInventoryItemIdForEbayItem(offer.itemId);
    } catch (error) {
      toastError(error, "Couldn't load the linked inventory item. Try again.");
      return;
    }
    if (!itemId) {
      toast.error(NO_LOCAL_ITEM);
      return;
    }
    const typed = check.cents;
    const result = await ai
      .mutateAsync({
        item_id: itemId,
        mode: "counter",
        offer_price: offer.price ?? undefined,
        currency: cur,
        buyer_message: offer.message ?? undefined,
        proposed_counter: typed != null && typed > 0 ? typed / 100 : undefined,
      })
      .catch(() => null); // toasted by the hook's shared AI error mapping
    if (!result) return;
    const next = applyNegotiationDraft({ price, note }, result);
    // JSON boundary: an older edge build without the guardrail omits warnings.
    draft.set({ price: next.price, note: next.note, warnings: result.warnings ?? [] });
  }

  async function sendCounter(e?: React.FormEvent) {
    e?.preventDefault();
    if (!check.ok || check.cents == null || busy) return;
    const ok = await act("Counter", check.cents / 100, note.trim() || undefined);
    if (ok) draft.clear();
  }

  const counterNet =
    check.cents != null && check.cents > 0
      ? netMarginCents({ ...economics, offerPrice: check.cents / 100 })
      : null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-3">
        {offer.message && (
          <blockquote className="rounded-md bg-background p-3 text-sm italic text-muted-foreground">
            "{offer.message}"
          </blockquote>
        )}
        {offer.buyerHistory && offer.buyerHistory.priorOffers > 0 && (
          <p className="text-xs text-muted-foreground">
            This buyer has offered {offer.buyerHistory.priorOffers} time
            {offer.buyerHistory.priorOffers === 1 ? "" : "s"} before
            {offer.buyerHistory.bestPriorCents != null
              ? `, best ${formatMoney(offer.buyerHistory.bestPriorCents, cur)}`
              : ""}
            {offer.buyerHistory.everAccepted ? " · you accepted one" : ""}.
          </p>
        )}
        <CostBreakdown offer={offer} />
        {gross != null && (
          <p className="text-xs text-muted-foreground">
            Before fees and postage this is {formatMoney(gross, cur)}
            {grossShare != null ? ` (${grossShare}%)` : ""}.
          </p>
        )}
      </div>

      {!live ? (
        <p className="text-sm text-muted-foreground">
          This offer is closed, so there is nothing to answer.
        </p>
      ) : (
        <form className="space-y-2" onSubmit={sendCounter} noValidate>
          <p className="text-sm font-medium">Counter this offer</p>
          {/* OM-15: priced from what the seller keeps, not guessed at. */}
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <Button
                  key={c.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-auto flex-col items-start gap-0 px-2 py-1 text-left"
                  onClick={() => patch({ price: (c.cents / 100).toFixed(2) })}
                >
                  <span className="text-xs font-medium">
                    {c.label}: {formatMoney(c.cents, cur)}
                  </span>
                  {c.netCents != null && (
                    <span
                      className={cn(
                        "text-xs font-normal",
                        c.netCents < 0 ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      you keep {formatMoney(c.netCents, cur)}
                    </span>
                  )}
                </Button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={priceRef}
              aria-label="Counter offer price"
              aria-invalid={check.reason ? true : undefined}
              aria-describedby={check.reason ? reasonId : undefined}
              type="text"
              inputMode="decimal"
              value={price}
              onChange={(e) => patch({ price: e.target.value })}
              placeholder="Counter price"
              className="h-8 w-32"
            />
            <Button
              type="submit"
              size="sm"
              className="h-8"
              disabled={busy || !check.ok}
            >
              {pendingAction === "Counter" ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Sending...
                </>
              ) : (
                "Send counter"
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              disabled={busy || ai.isPending}
              onClick={draftCounter}
            >
              {ai.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-3.5 w-3.5" />
              )}
              Draft with AI
            </Button>
          </div>
          {check.reason && (
            <p id={reasonId} className="text-xs font-medium text-destructive">
              {check.reason}
            </p>
          )}
          {/* US-2236 AC2 / US-3194: what the COUNTER nets, by the same arithmetic
              as the row. A counter is an offer to sell at that price, so it loses
              the same fees and the same postage — showing it gross was how a
              counter that loses money could read as a positive margin. */}
          {counterNet != null && (
            <p
              className={
                counterNet < 0
                  ? "text-xs font-medium text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {counterNet < 0 ? "Loses money" : "Nets"}:{" "}
              {formatMoney(counterNet, cur)} after fees and postage
              {offer.quantity && offer.quantity > 1 ? ` each, for ${offer.quantity}` : ""}
            </p>
          )}
          <Textarea
            aria-label="Note to the buyer"
            aria-describedby={noteCountId}
            value={note}
            maxLength={SELLER_RESPONSE_MAX}
            onChange={(e) => patch({ note: e.target.value })}
            rows={2}
            placeholder="Optional note to the buyer"
          />
          <p id={noteCountId} className="text-right text-xs text-muted-foreground tabular-nums">
            {note.length} / {SELLER_RESPONSE_MAX}
          </p>
          {warnings.length > 0 && (
            <ul className="space-y-0.5">
              {warnings.map((w) => (
                <li key={w} className="text-xs font-medium text-destructive">
                  {w}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Drafting spends one AI action and never overwrites what you typed.
          </p>
        </form>
      )}
    </div>
  );
}

/** The breakdown lines, shared by the panel and the loss confirm (OM-06). */
function costLines(offer: EbayBestOffer): [string, number][] {
  if (offer.price == null) return [];
  const lines: [string, number][] = [
    ["Buyer pays", Math.round(offer.price * 100)],
    ["eBay fees", -Math.round(ebayFeesFor(offer.price) * 100)],
    ["What it cost you", -Math.round((offer.itemCost ?? 0) * 100)],
  ];
  if (offer.shippingCost) {
    lines.push(["Postage", -Math.round(offer.shippingCost * 100)]);
  }
  if (offer.gradingCost) {
    lines.push(["Grading", -Math.round(offer.gradingCost * 100)]);
  }
  const net = netMarginCents(offerEconomics(offer));
  if (net != null) lines.push(["You keep", net]);
  return lines;
}

/**
 * Where the offer money goes, line by line.
 *
 * Renders nothing without a cost on record, because every line below the offer
 * price would then be a real number sitting above an unknown total, which reads
 * as a complete sum that happens to end in a dash.
 */
function CostBreakdown({ offer }: { offer: EbayBestOffer }) {
  const cur = offer.currency ?? "USD";
  const economics = offerEconomics(offer);
  const net = netMarginCents(economics);
  if (net == null || offer.price == null) return null;

  const lines = costLines(offer).slice(0, -1);

  return (
    <dl className="space-y-1 text-xs">
      {lines.map(([label, cents]) => (
        <div key={label} className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{formatMoney(cents, cur)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-4 border-t pt-1 font-medium">
        <dt>You keep</dt>
        <dd className={cn("tabular-nums", net < 0 && "text-destructive")}>
          {formatMoney(net, cur)}
        </dd>
      </div>
    </dl>
  );
}
