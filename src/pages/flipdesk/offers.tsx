import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  ImageOff,
  Info,
  Loader2,
  MessageSquare,
  Reply,
  Send,
  Tag,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  useEbayBestOffers,
  useEbayConnection,
  useEbayEligibleOffers,
  useEbayMessages,
  useEbayNegotiationCapability,
  useEbayReplyMessage,
  useEbayRespondOffer,
  useEbaySendOffer,
  type EbayBestOffer,
  type EbayBuyerMessage,
} from "@/hooks/use-ebay";

// US-1040/1041: web parity for eBay Best Offers (accept/decline/counter), send
// offers to interested buyers, and the buyer-message inbox — features that were
// edge + iOS only.
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
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Offers & Messages</h1>
        <p className="text-sm text-muted-foreground">
          Respond to buyer Best Offers, send offers to interested buyers, and
          reply to buyer messages — all on your live eBay listings.
        </p>
      </div>
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
          <p className="text-sm text-muted-foreground">No open offers.</p>
        ) : (
          offers.map((o) => <OfferRow key={o.bestOfferId} offer={o} />)
        )}
      </CardContent>
    </Card>
  );
}

function OfferRow({ offer }: { offer: EbayBestOffer }) {
  const qc = useQueryClient();
  const respond = useEbayRespondOffer();
  const [countering, setCountering] = useState(false);
  const [counterPrice, setCounterPrice] = useState("");

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

  const busy = respond.isPending;
  const cur = offer.currency ?? "USD";

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
        <div className="mt-3 flex items-center gap-2">
          <Input
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
            variant="ghost"
            className="h-8"
            onClick={() => setCountering(false)}
          >
            Cancel
          </Button>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4 text-brand-red-text" />
          Buyer messages
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
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
          <p className="text-sm text-muted-foreground">No recent messages.</p>
        ) : (
          messages.map((m) => <MessageRow key={m.messageId} message={m} />)
        )}
      </CardContent>
    </Card>
  );
}

function MessageRow({ message }: { message: EbayBuyerMessage }) {
  const qc = useQueryClient();
  const reply = useEbayReplyMessage();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const canReply = !!message.itemId && !!message.senderUsername;

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
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
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
