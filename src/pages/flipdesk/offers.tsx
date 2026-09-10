import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { ImageOff, Info, Loader2, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlatformCoverageNote } from "@/components/flipdesk/platform-coverage-note";
import {
  useEbayBestOffers,
  useEbayConnection,
  useEbayEligibleOffers,
  useEbayMessages,
  useEbayNegotiationCapability,
  useEbaySendOffer,
} from "@/hooks/use-ebay";
import { PageHelp } from "@/components/help/page-help";
import { OfferAnalyticsCard } from "@/components/flipdesk/offer-analytics-card";
import { OfferThresholdConflicts } from "@/components/flipdesk/offer-threshold-conflicts";
import { SendOffersToday } from "@/components/flipdesk/send-offers-today";
import { BestOffersPanel } from "@/components/flipdesk/best-offers-table";
import { BuyerMessagesPanel } from "@/components/flipdesk/buyer-messages-table";
import { isOpenOffer } from "@/pages/flipdesk/offers-sort";
import {
  DEFAULT_OFFERS_TAB,
  OFFERS_TABS,
  offersTabCounts,
  resolveOffersTabId,
  type OffersTabId,
} from "@/pages/flipdesk/offers-tabs";

// US-1040/1041: web parity for eBay Best Offers (accept/decline/counter), send
// offers to interested buyers, and the buyer-message inbox — features that were
// edge + iOS only.
//
// US-3297 rebuilt the surface. It used to be six sections stacked in one 768px
// column, all rendered at once, each list a run of bordered divs about 140px
// tall per row. Two of those sections are inboxes with their own clocks, and
// neither could be sorted — so "which offer expires first" and "who is still
// waiting on a reply" both meant reading the whole page. It is now one section
// per tab (see offers-tabs.ts) with real tables (best-offers-table.tsx,
// buyer-messages-table.tsx) that sort, filter, page, and put the long-form
// detail one click down instead of in the way of the next row.
export function FlipdeskOffersPage() {
  const { data: connection, isLoading: connLoading } = useEbayConnection();
  const connected = !!connection;

  if (connLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-2">
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
    // Wider than the old max-w-3xl, because the content is now a table. Seven
    // columns in a 768px column would wrap the item title to three lines and
    // undo the row height the table was built to win back.
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Offers & Messages"
        subtitle="Answer Best Offers before they expire, reply to buyers, and offer your watchers a discount. The number on each tab is what is waiting on you."
        actions={<PageHelp slug="offers-and-buyer-messages" />}
      />
      {/* US-2541: FlipDesk registers eleven marketplaces and this screen reads
          one. Without saying so, an empty list means "no offers" to a seller
          who also lists on Poshmark — when it means "we do not read Poshmark". */}
      <PlatformCoverageNote feature="offers" noun="Offers and buyer messages" />
      <OffersTabs />
    </div>
  );
}

/**
 * One section on screen, chosen by a tab, instead of six stacked.
 *
 * The tab lives in `?tab=`, like the inventory table and the post-sale page, so
 * a tab is a link a seller can bookmark or send to a teammate.
 *
 * BOTH INBOX QUERIES RUN HERE, on every tab, and that is deliberate rather than
 * an oversight: the badges are the reason the tabs work, and a badge that only
 * appears once you visit the tab is worse than no badge. Both queries are the
 * same ones the panels use, so TanStack serves the panel from cache when the
 * tab opens — the counts cost nothing extra.
 */
function OffersTabs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: OffersTabId =
    resolveOffersTabId(searchParams.get("tab")) ?? DEFAULT_OFFERS_TAB;

  const offers = useEbayBestOffers();
  const messages = useEbayMessages();

  const counts = useMemo(
    () =>
      offersTabCounts({
        openOffers: (offers.data ?? []).filter((o) => isOpenOffer(o)).length,
        unansweredMessages: (messages.data ?? []).filter((m) => !m.answered)
          .length,
      }),
    [offers.data, messages.data],
  );
  const countLoading: Record<OffersTabId, boolean> = {
    offers: offers.isLoading,
    messages: messages.isLoading,
    send: false,
    insights: false,
  };

  function setTab(next: OffersTabId) {
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    // replace: tabbing is looking around, not navigation. Twelve taps through
    // the tabs should not mean twelve presses of the back button to leave.
    setSearchParams(params, { replace: true });
  }

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as OffersTabId)}>
        <TabsList className="flex flex-wrap">
          {OFFERS_TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="gap-2">
              {t.label}
              {/* No badge while the query is still running, and none on a tab
                  that counts nothing. A "0" that is really "not known yet"
                  reads as "nothing waiting", which is the one wrong answer
                  this page must not give. */}
              {t.counted && !countLoading[t.id] && counts[t.id] > 0 && (
                <Badge
                  variant={tab === t.id ? "default" : "secondary"}
                  className="px-1.5 py-0 text-[10px] tabular-nums"
                >
                  {counts[t.id].toLocaleString()}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === "offers" && (
        <>
          {/* US-2944: above the table, because it is about the offers that will
              never reach it — eBay answers those first. Renders nothing when
              there is no rule or no conflict. */}
          <OfferThresholdConflicts />
          <BestOffersPanel />
        </>
      )}
      {tab === "messages" && <BuyerMessagesPanel />}
      {tab === "send" && (
        <>
          {/* US-2943: above the manual picker, because it is the answer to the
              question the picker makes the seller work out for themselves —
              which items are worth offering today. */}
          <SendOffersToday />
          <SendOfferCard />
        </>
      )}
      {tab === "insights" && <OfferAnalyticsCard />}
    </>
  );
}

// ── Send offers to interested buyers ────────────────────────────────
//
// Unchanged by US-3297 apart from where it lives. This is a picker, not a
// queue: the seller chooses from a short eligibility list and sends once, so
// there is nothing here to sort by and nothing waiting to be answered.
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
      toastError(err, "Couldn't send offers.");
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
                decline, and counter them on the Offers tab.
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
