import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Info,
  Loader2,
  MessageSquare,
  Reply,
  Send,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { PlatformCoverageNote } from "@/components/flipdesk/platform-coverage-note";
import {
  useEbayBestOffers,
  useEbayConnection,
  useEbayEligibleOffers,
  useEbayMessages,
  useEbayNegotiationCapability,
  useEbayReplyMessage,
  useEbayRespondOffer,
  useEbaySendOffer,
  resolveInventoryItemIdForEbayItem,
  type EbayBestOffer,
  type EbayBuyerMessage,
} from "@/hooks/use-ebay";
import { useNegotiationDraft } from "@/hooks/use-ai-extract";
import { applyNegotiationDraft } from "@/pages/flipdesk/negotiation-draft-prefill";
import { PageHelp } from "@/components/help/page-help";

// US-1040/1041: web parity for eBay Best Offers (accept/decline/counter), send
// offers to interested buyers, and the buyer-message inbox — features that were
// edge + iOS only.
// US-2236 AC3: high-volume negotiation shouldn't render one flat list. Both the
// offers and messages lists page client-side at this size.
const LIST_PAGE_SIZE = 15;

// US-2494: the AI drafter reads the local inventory item (title, asking price,
// cost), so an offer or message on a listing FlipDesk never imported has nothing
// to draft from. Said once, used by both forms.
const NO_LOCAL_ITEM =
  "This listing isn't linked to a FlipDesk item, so there's nothing for the draft to read.";

function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 pt-1">
      <Button
        size="sm"
        variant="outline"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-xs text-muted-foreground">
        Page {page + 1} of {pageCount}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(page + 1)}
        aria-label="Next page"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function FlipdeskOffersPage() {
  const { data: connection, isLoading: connLoading } = useEbayConnection();
  const connected = !!connection;

  if (connLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 py-12 text-center">
        <h1 className="text-xl font-semibold">Offers & Messages</h1>
        <p className="text-sm text-muted-foreground">
          Connect your eBay account to manage Best Offers and buyer messages.
        </p>
        <Button asChild variant="outline">
          <a href="/dashboard/flipdesk/marketplaces">Go to Marketplaces</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Offers & Messages"
        subtitle="Respond to buyer Best Offers, send offers to interested buyers, and reply to buyer messages — all on your live eBay listings."
              actions={<PageHelp slug="offers-and-buyer-messages" />}
      />
      {/* US-2541: FlipDesk registers eleven marketplaces and this screen reads
          one. Without saying so, an empty list means "no offers" to a seller
          who also lists on Poshmark — when it means "we do not read Poshmark". */}
      <PlatformCoverageNote feature="offers" noun="Offers and buyer messages" />
      <BestOffersCard />
      <SendOfferCard />
      <MessagesCard />
    </div>
  );
}

// ── Best Offers ─────────────────────────────────────────────────────
function BestOffersCard() {
  const {
    data: offers = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useEbayBestOffers();
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(offers.length / LIST_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedOffers = offers.slice(
    safePage * LIST_PAGE_SIZE,
    safePage * LIST_PAGE_SIZE + LIST_PAGE_SIZE,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Tag className="h-4 w-4 text-brand-red-text" />
          Best Offers
          {offers.length > 0 && (
            <Badge variant="secondary" className="ml-1">
              {offers.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
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
        ) : (
          <>
            {pagedOffers.map((o) => (
              <OfferRow key={o.bestOfferId} offer={o} />
            ))}
            <Pager page={safePage} pageCount={pageCount} onPage={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function OfferRow({ offer }: { offer: EbayBestOffer }) {
  const qc = useQueryClient();
  const respond = useEbayRespondOffer();
  const draft = useNegotiationDraft();
  const [countering, setCountering] = useState(false);
  const [counterPrice, setCounterPrice] = useState("");
  const [counterNote, setCounterNote] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const busy = respond.isPending;
  const cur = offer.currency ?? "USD";

  async function act(action: "Accept" | "Decline" | "Counter") {
    const counter = Number(counterPrice);
    if (action === "Counter" && (!Number.isFinite(counter) || counter <= 0)) {
      toast.error("Enter a valid counter price.");
      return;
    }
    try {
      await respond.mutateAsync({
        bestOfferId: offer.bestOfferId,
        itemId: offer.itemId,
        action,
        counterPrice: action === "Counter" ? counter : undefined,
        message:
          action === "Counter" ? counterNote.trim() || undefined : undefined,
      });
      await qc.invalidateQueries({ queryKey: ["ebay_best_offers"] });
      toast.success(
        action === "Accept"
          ? "Offer accepted."
          : action === "Decline"
            ? "Offer declined."
            : "Counter offer sent.",
      );
    } catch (err) {
      toast.error(`Couldn't respond: ${(err as Error).message}`);
    }
  }

  // US-2494: one AI action per press, so this only ever runs from the button.
  // The offer carries eBay's item id; the drafter needs the local row's UUID.
  async function draftCounter() {
    const itemId = await resolveInventoryItemIdForEbayItem(offer.itemId);
    if (!itemId) {
      toast.error(NO_LOCAL_ITEM);
      return;
    }
    const typed = Number(counterPrice);
    const result = await draft
      .mutateAsync({
        item_id: itemId,
        mode: "counter",
        offer_price: offer.price ?? undefined,
        currency: cur,
        buyer_message: offer.message ?? undefined,
        proposed_counter:
          Number.isFinite(typed) && typed > 0 ? typed : undefined,
      })
      .catch(() => null); // toasted by the hook's shared AI error mapping
    if (!result) return;
    const next = applyNegotiationDraft(
      { price: counterPrice, note: counterNote },
      result,
    );
    setCounterPrice(next.price);
    setCounterNote(next.note);
    // JSON boundary: an older edge build without the guardrail omits warnings.
    setWarnings(result.warnings ?? []);
  }

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {offer.itemTitle || offer.itemId}
          </p>
          <p className="text-xs text-muted-foreground">
            {offer.buyerUsername ? `${offer.buyerUsername} · ` : ""}
            {offer.price != null
              ? `${cur} ${offer.price.toFixed(2)}`
              : "—"}
            {offer.quantity ? ` · qty ${offer.quantity}` : ""}
          </p>
          {offer.message && (
            <p className="mt-1 text-xs italic text-muted-foreground">
              "{offer.message}"
            </p>
          )}
        </div>
        {offer.status && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {offer.status}
          </Badge>
        )}
      </div>

      {countering ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Counter offer price"
              type="number"
              step="0.01"
              min="0.01"
              value={counterPrice}
              onChange={(e) => setCounterPrice(e.target.value)}
              placeholder="Counter price"
              className="h-8 w-32"
            />
            <Button size="sm" className="h-8" disabled={busy} onClick={() => act("Counter")}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Send counter"}
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
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => {
                setCountering(false);
                setWarnings([]);
              }}
            >
              Cancel
            </Button>
          </div>
          {/* US-2236 AC2: margin at this counter, so a below-break-even offer is
              visible. Only when we know the item's cost. */}
          {offer.itemCost != null &&
            Number.isFinite(Number(counterPrice)) &&
            Number(counterPrice) > 0 &&
            (() => {
              const margin = Number(counterPrice) - offer.itemCost;
              const below = margin < 0;
              return (
                <p
                  className={
                    below
                      ? "text-xs font-medium text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {below ? "Below cost" : "Margin"}: {cur} {margin.toFixed(2)}
                  {" · "}cost {cur} {offer.itemCost.toFixed(2)}
                </p>
              );
            })()}
          <Textarea
            aria-label="Note to the buyer"
            value={counterNote}
            onChange={(e) => setCounterNote(e.target.value)}
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
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" className="h-8" disabled={busy} onClick={() => act("Accept")}>
            <Check className="mr-1 h-3.5 w-3.5" /> Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy}
            onClick={() => setCountering(true)}
          >
            <Reply className="mr-1 h-3.5 w-3.5" /> Counter
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-destructive"
            disabled={busy}
            onClick={() => act("Decline")}
          >
            <X className="mr-1 h-3.5 w-3.5" /> Decline
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Send offers to interested buyers ────────────────────────────────
function SendOfferCard() {
  const [open, setOpen] = useState(false);
  // US-1967: ask whether the feature works before offering it. The eligible
  // query stays disabled while unavailable so we never fire a request whose
  // only possible outcome is a 501.
  const { data: capability, isLoading: capLoading } =
    useEbayNegotiationCapability();
  const unavailable = capability?.sendOfferAvailable === false;
  const { data: items = [], isLoading } = useEbayEligibleOffers(
    open && !unavailable,
  );
  const send = useEbaySendOffer();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [discount, setDiscount] = useState("10");
  const [message, setMessage] = useState("");

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0) {
      toast.error("Select at least one listing.");
      return;
    }
    const pct = Number(discount);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 90) {
      toast.error("Enter a discount between 1 and 90%.");
      return;
    }
    try {
      const res = await send.mutateAsync({
        listingIds: [...selected],
        discountPercentage: String(Math.round(pct)),
        message: message.trim() || undefined,
      });
      toast.success(`Offer sent on ${res.count} listing(s).`);
      setSelected(new Set());
      setMessage("");
      setOpen(false);
    } catch (err) {
      toast.error(`Couldn't send offers: ${(err as Error).message}`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4 text-brand-red-text" />
          Send offers to interested buyers
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Send a private discount offer to buyers watching your eligible
          listings.
        </p>
        {capLoading ? (
          <Skeleton className="h-9 w-36" />
        ) : unavailable ? (
          // US-1967: no dead button. The server's own copy distinguishes "not
          // licensed yet" (nothing to do) from "reconnect to enable" (a real
          // fix), so don't paper over it with a generic message.
          <div className="flex items-start gap-2 rounded-md border border-dashed p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {capability?.code === "reconnect_required"
                  ? "Reconnect eBay to enable this"
                  : "Not available yet"}
              </p>
              <p className="text-sm text-muted-foreground">
                {capability?.detail ??
                  "Sending offers to interested buyers isn't available on this eBay connection yet."}
              </p>
              {capability?.code === "reconnect_required" && (
                <Button asChild variant="outline" size="sm" className="mt-1">
                  <a href="/dashboard/flipdesk/marketplaces">Reconnect eBay</a>
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                Best Offers from buyers are unaffected — you can still accept,
                decline, and counter them above.
              </p>
            </div>
          </div>
        ) : !open ? (
          <Button variant="outline" onClick={() => setOpen(true)}>
            Choose listings
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
              {isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : items.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">
                  No eligible listings (need active watchers).
                </p>
              ) : (
                items.map((it) => {
                  const priceLabel =
                    typeof it.price === "number" && it.price > 0
                      ? new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: it.currency || "USD",
                        }).format(it.price)
                      : null;
                  // listing id shown only when nothing else resolves.
                  const primary = it.title || `Listing ${it.listingId}`;
                  const secondary = [priceLabel, it.condition]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <label
                      key={it.listingId}
                      className="flex cursor-pointer items-center gap-2 rounded p-1.5 hover:bg-muted"
                    >
                      <Checkbox
                        checked={selected.has(it.listingId)}
                        onCheckedChange={() => toggle(it.listingId)}
                      />
                      {it.imageUrl ? (
                        <img
                          src={it.imageUrl}
                          alt=""
                          loading="lazy"
                          width={40}
                          height={40}
                          className="h-10 w-10 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted">
                          <ImageOff className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{primary}</p>
                        {secondary && (
                          <p className="truncate text-xs text-muted-foreground">
                            {secondary}
                          </p>
                        )}
                      </div>
                    </label>
                  );
                })
              )}
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="offers-discount" className="text-sm">Discount</label>
              <Input
                id="offers-discount"
                type="number"
                min="1"
                max="90"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                className="h-8 w-20"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            <Textarea
              aria-label="Message to buyers"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="Optional message to buyers"
            />
            <div className="flex gap-2">
              <Button onClick={submit} disabled={send.isPending}>
                {send.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                Send offer ({selected.size})
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Buyer messages ──────────────────────────────────────────────────
function MessagesCard() {
  const {
    data: messages = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useEbayMessages();
  // US-2236 AC3: "unread" for a buyer thread is one that still needs a reply —
  // EbayBuyerMessage exposes `answered`, so unanswered is the actionable subset.
  const [unansweredOnly, setUnansweredOnly] = useState(false);
  const [page, setPage] = useState(0);
  const unansweredCount = messages.filter((m) => !m.answered).length;
  const filtered = unansweredOnly ? messages.filter((m) => !m.answered) : messages;
  const pageCount = Math.max(1, Math.ceil(filtered.length / LIST_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedMessages = filtered.slice(
    safePage * LIST_PAGE_SIZE,
    safePage * LIST_PAGE_SIZE + LIST_PAGE_SIZE,
  );
  useEffect(() => {
    setPage(0);
  }, [unansweredOnly]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4 text-brand-red-text" />
          Buyer messages
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!isLoading && !error && messages.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={unansweredOnly ? "default" : "outline"}
              onClick={() => setUnansweredOnly((v) => !v)}
            >
              Needs reply
              {unansweredCount > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {unansweredCount}
                </Badge>
              )}
            </Button>
          </div>
        )}
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : error ? (
          <ErrorState
            className="py-6"
            hideSupport
            title="Couldn't load messages"
            description={(error as Error).message}
            onRetry={() => refetch()}
            retrying={isFetching}
          />
        ) : messages.length === 0 ? (
          // US-2541: a bare sentence where every other list on this surface
          // gets a real empty state — and this one is the most ambiguous of
          // them, because "no messages" reads as coverage the page does not
          // have.
          <EmptyState
            className="py-8"
            icon={MessageSquare}
            title="No recent buyer messages"
            description="eBay messages from the last 30 days appear here. Messages on your other marketplaces are not read by GradeThread."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={Check}
            title="Nothing needs a reply"
            description="Every recent message has been answered. Clear the filter to see them all."
          />
        ) : (
          <>
            {pagedMessages.map((m) => (
              <MessageRow key={m.messageId} message={m} />
            ))}
            <Pager page={safePage} pageCount={pageCount} onPage={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MessageRow({ message }: { message: EbayBuyerMessage }) {
  const qc = useQueryClient();
  const reply = useEbayReplyMessage();
  const draft = useNegotiationDraft();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const canReply = !!message.itemId && !!message.senderUsername;

  // US-2494: one AI action per press. The message carries eBay's item id; the
  // drafter reads the local inventory row, so resolve one to the other first.
  async function draftReply() {
    if (!message.itemId) return;
    const itemId = await resolveInventoryItemIdForEbayItem(message.itemId);
    if (!itemId) {
      toast.error(NO_LOCAL_ITEM);
      return;
    }
    const result = await draft
      .mutateAsync({
        item_id: itemId,
        mode: "reply",
        buyer_message: message.body ?? undefined,
      })
      .catch(() => null); // toasted by the hook's shared AI error mapping
    if (!result) return;
    setText(applyNegotiationDraft({ price: "", note: text }, result).note);
  }

  async function send() {
    if (!text.trim()) {
      toast.error("Enter a reply.");
      return;
    }
    if (!message.itemId || !message.senderUsername) return;
    try {
      await reply.mutateAsync({
        messageId: message.messageId,
        itemId: message.itemId,
        recipientId: message.senderUsername,
        body: text.trim(),
      });
      await qc.invalidateQueries({ queryKey: ["ebay_messages"] });
      toast.success("Reply sent.");
      setText("");
      setOpen(false);
    } catch (err) {
      toast.error(`Couldn't reply: ${(err as Error).message}`);
    }
  }

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {message.senderUsername || "Buyer"}
            {message.subject ? ` · ${message.subject}` : ""}
          </p>
          {message.body && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
              {message.body}
            </p>
          )}
        </div>
        {message.answered && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            Replied
          </Badge>
        )}
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          <Textarea
            aria-label="Reply to this buyer"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Your reply"
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={send} disabled={reply.isPending}>
              {reply.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Reply className="mr-2 h-3.5 w-3.5" />
              )}
              Send reply
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={reply.isPending || draft.isPending}
              onClick={draftReply}
            >
              {draft.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-3.5 w-3.5" />
              )}
              Draft with AI
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Drafting spends one AI action and never overwrites what you typed.
          </p>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 h-8"
          disabled={!canReply}
          title={canReply ? undefined : "This message can't be replied to here."}
          onClick={() => setOpen(true)}
        >
          <Reply className="mr-1 h-3.5 w-3.5" /> Reply
        </Button>
      )}
    </div>
  );
}
