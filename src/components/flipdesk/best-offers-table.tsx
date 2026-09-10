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

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
  type EbayBestOffer,
} from "@/hooks/use-ebay";
import { useNegotiationDraft } from "@/hooks/use-ai-extract";
import { applyNegotiationDraft } from "@/pages/flipdesk/negotiation-draft-prefill";
import {
  formatMoney,
  grossMarginCents,
  marginPct,
  netMarginCents,
  netMarginPct,
  pctOfList,
  readExpiry,
} from "@/pages/flipdesk/offer-economics";
import {
  DEFAULT_OFFER_SORT,
  filterOffers,
  naturalOfferDir,
  nextSort,
  offerEconomics,
  sortOffers,
  type OfferSort,
  type OfferSortField,
} from "@/pages/flipdesk/offers-sort";
import { ebayFeesFor } from "@/lib/ebay-fees";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

// US-2494: the AI drafter reads the local inventory item (title, asking price,
// cost), so an offer on a listing FlipDesk never imported has nothing to draft
// from.
const NO_LOCAL_ITEM =
  "This listing isn't linked to a FlipDesk item, so there's nothing for the draft to read.";

export function BestOffersPanel() {
  const {
    data: offers = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useEbayBestOffers();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<OfferSort>(DEFAULT_OFFER_SORT);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(
    () => sortOffers(filterOffers(offers, query), sort),
    [offers, query, sort],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // Typing in the filter while on page 3 of the old result set would otherwise
  // land on an empty page, which reads as "no matches".
  useEffect(() => {
    setPage(0);
  }, [query, sort]);

  function toggleSort(field: OfferSortField) {
    setSort((s) => nextSort(s, field, naturalOfferDir(field)));
  }

  function toggleExpanded(id: string) {
    setExpanded((cur) => (cur === id ? null : id));
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Tag className="h-4 w-4 text-brand-red-text" />
          Best Offers
          {offers.length > 0 && (
            <Badge variant="secondary" className="ml-1 tabular-nums">
              {offers.length.toLocaleString()}
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
        ) : offers.length === 0 ? (
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
      </CardContent>
    </Card>
  );
}

// ── responding ──────────────────────────────────────────────────────────────

/**
 * Accept, decline and counter for one offer.
 *
 * Created ONCE per offer, by the row (or the phone card), and handed to both
 * the button group and the detail panel. One mutation means one pending flag,
 * so a seller cannot press Accept while their counter on the same offer is
 * still in flight — two calls to this hook would give the two halves of the
 * row separate `busy` states that each think the other is idle.
 */
function useOfferResponse(offer: EbayBestOffer) {
  const qc = useQueryClient();
  const respond = useEbayRespondOffer();

  async function act(
    action: "Accept" | "Decline" | "Counter",
    counterPrice?: number,
    message?: string,
  ) {
    if (action === "Counter" && (!Number.isFinite(counterPrice) || (counterPrice ?? 0) <= 0)) {
      toast.error("Enter a valid counter price.");
      return false;
    }
    try {
      await respond.mutateAsync({
        bestOfferId: offer.bestOfferId,
        itemId: offer.itemId,
        action,
        counterPrice: action === "Counter" ? counterPrice : undefined,
        message: action === "Counter" ? message : undefined,
      });
      await qc.invalidateQueries({ queryKey: ["ebay_best_offers"] });
      toast.success(
        action === "Accept"
          ? "Offer accepted."
          : action === "Decline"
            ? "Offer declined."
            : "Counter offer sent.",
      );
      return true;
    } catch (err) {
      toastError(err, "Couldn't respond.");
      return false;
    }
  }

  return { act, busy: respond.isPending };
}

type OfferResponse = ReturnType<typeof useOfferResponse>;

function OfferActions({
  respond,
  onCounter,
  size = "sm",
}: {
  respond: OfferResponse;
  onCounter: () => void;
  size?: "sm" | "default";
}) {
  const { act, busy } = respond;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button
        size={size}
        className="h-8"
        disabled={busy}
        onClick={() => act("Accept")}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
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
        <Reply className="mr-1 h-3.5 w-3.5" /> Counter
      </Button>
      <Button
        size={size}
        variant="ghost"
        className="h-8 text-destructive"
        disabled={busy}
        onClick={() => act("Decline")}
      >
        <X className="mr-1 h-3.5 w-3.5" /> Decline
      </Button>
    </div>
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
      className="text-[10px] font-normal"
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
}: {
  offer: EbayBestOffer;
  open: boolean;
  onToggle: () => void;
}) {
  const cur = offer.currency ?? "USD";
  const share = pctOfList(offerEconomics(offer));
  const detailRef = useRef<HTMLInputElement>(null);
  const respond = useOfferResponse(offer);

  function openAndFocusCounter() {
    if (!open) onToggle();
    // The input only exists once the detail row is mounted, so focus lands on
    // the next tick either way.
    setTimeout(() => detailRef.current?.focus(), 0);
  }

  return (
    <>
      <TableRow
        className="cursor-pointer align-top"
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
            </span>
          )}
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
          <OfferActions respond={respond} onCounter={openAndFocusCounter} />
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={8} className="whitespace-normal p-4">
            <OfferDetail offer={offer} respond={respond} priceRef={detailRef} />
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
}: {
  offer: EbayBestOffer;
  open: boolean;
  onToggle: () => void;
}) {
  const cur = offer.currency ?? "USD";
  const share = pctOfList(offerEconomics(offer));
  const priceRef = useRef<HTMLInputElement>(null);
  const respond = useOfferResponse(offer);

  function openAndFocusCounter() {
    if (!open) onToggle();
    setTimeout(() => priceRef.current?.focus(), 0);
  }

  return (
    <div className="rounded-md border">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full p-3 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="line-clamp-2 text-sm font-medium">
            {offer.itemTitle || offer.itemId}
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
        <OfferActions respond={respond} onCounter={openAndFocusCounter} />
      </div>
      {open && (
        <div className="border-t bg-muted/30 p-3">
          <OfferDetail offer={offer} respond={respond} priceRef={priceRef} />
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
}: {
  offer: EbayBestOffer;
  respond: OfferResponse;
  priceRef: RefObject<HTMLInputElement | null>;
}) {
  const { act, busy } = respond;
  const draft = useNegotiationDraft();
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const cur = offer.currency ?? "USD";
  const economics = offerEconomics(offer);
  const gross = grossMarginCents(economics);
  const grossShare = marginPct(economics);

  // US-2494: one AI action per press, so this only ever runs from the button.
  // The offer carries eBay's item id; the drafter needs the local row's UUID.
  async function draftCounter() {
    const itemId = await resolveInventoryItemIdForEbayItem(offer.itemId);
    if (!itemId) {
      toast.error(NO_LOCAL_ITEM);
      return;
    }
    const typed = Number(price);
    const result = await draft
      .mutateAsync({
        item_id: itemId,
        mode: "counter",
        offer_price: offer.price ?? undefined,
        currency: cur,
        buyer_message: offer.message ?? undefined,
        proposed_counter: Number.isFinite(typed) && typed > 0 ? typed : undefined,
      })
      .catch(() => null); // toasted by the hook's shared AI error mapping
    if (!result) return;
    const next = applyNegotiationDraft({ price, note }, result);
    setPrice(next.price);
    setNote(next.note);
    // JSON boundary: an older edge build without the guardrail omits warnings.
    setWarnings(result.warnings ?? []);
  }

  async function sendCounter() {
    const ok = await act("Counter", Number(price), note.trim() || undefined);
    if (ok) {
      setPrice("");
      setNote("");
      setWarnings([]);
    }
  }

  const typedCounter = Number(price);
  const counterNet =
    Number.isFinite(typedCounter) && typedCounter > 0
      ? netMarginCents({ ...economics, offerPrice: typedCounter })
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

      <div className="space-y-2">
        <p className="text-sm font-medium">Counter this offer</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={priceRef}
            aria-label="Counter offer price"
            type="number"
            step="0.01"
            min="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Counter price"
            className="h-8 w-32"
          />
          <Button
            size="sm"
            className="h-8"
            disabled={busy}
            onClick={sendCounter}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "Send counter"
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy || draft.isPending}
            onClick={draftCounter}
          >
            {draft.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3.5 w-3.5" />
            )}
            Draft with AI
          </Button>
        </div>
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
          </p>
        )}
        <Textarea
          aria-label="Note to the buyer"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Optional note to the buyer"
        />
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
      </div>
    </div>
  );
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
