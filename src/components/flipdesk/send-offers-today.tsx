import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import {
  parseDiscountInput,
  SEND_OFFER_MAX_PCT,
  SEND_OFFER_MIN_PCT,
  SEND_OFFER_RANGE_COPY,
} from "@/lib/offer-limits";
import { formatMoney } from "@/pages/flipdesk/offer-economics";
import {
  describeSendResult,
  discountExposureCents,
  sendConfirmCopy,
} from "@/pages/flipdesk/send-offer-result";
import { useEbaySendOffer, useEbaySendOffersToday } from "@/hooks/use-ebay";

// US-2943: the morning list of watchers worth an offer.
//
// find_eligible_items was on-demand, so a seller had to think to go and look —
// and the whole value of send-offer is that it reaches people ALREADY watching
// an item who have not pulled the trigger. A list nobody opens is a feature
// that does not exist.
//
// ── A PROPOSAL, WITH THE WORST CASE ON IT ───────────────────────────────────
//
// Nothing sends without a click, and a bulk send confirms the count AND the
// largest amount that can come out of it. "Send 12% off to 40 items" is a
// number a seller should see before, not after.
//
// ── AND WHEN THE SCOPE IS MISSING ───────────────────────────────────────────
//
// eBay gates send-offer behind a restricted scope (US-1421). The route answers
// 200 with a typed reason and the markdown-sale fallback in the same response,
// so this card says what is wrong and what to do instead, in one place, rather
// than rendering an error the seller can do nothing about.

function money(cents: number | null | undefined): string {
  return cents == null ? "-" : formatMoney(cents);
}

export function SendOffersToday() {
  const confirm = useConfirm();
  const [searchParams] = useSearchParams();
  // OM-12: ?discount= from the Insights link prefills the box.
  const [discount, setDiscount] = useState(
    () => String(parseDiscountInput(searchParams.get("discount") ?? "") ?? 10),
  );
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // OM-12: one discount rule for both cards, and nothing substituted. This
  // used to turn 0 into 10 and 75 into 60 without saying so.
  const pct = parseDiscountInput(discount);
  // OM-04: tenant-keyed, and the discount is not part of the key.
  const { data, isLoading, isError, refetch, isFetching } = useEbaySendOffersToday();
  // OM-04: the shared hook, which also refreshes this list, the eligible list
  // and the analytics once an offer goes out.
  const send = useEbaySendOffer();

  const selected = useMemo(
    () => (data?.candidates ?? []).filter((c) => picked.has(c.listingId)),
    [data, picked],
  );
  // The worst case for the SELECTION, recomputed here rather than reusing the
  // whole-list figure the server sent — a seller who ticked four of forty items
  // must not be shown the exposure of all forty.
  async function sendSelected() {
    if (selected.length === 0 || pct == null) return;
    const exposure = discountExposureCents(selected.map((c) => c.priceCents), pct);
    const ok = await confirm({
      ...sendConfirmCopy(selected.length, pct, exposure, "item"),
      confirmLabel: "Send offers",
    });
    if (!ok) return;
    const ids = selected.map((c) => c.listingId);
    send.mutate(
      { listingIds: ids, discountPct: pct },
      {
        onSuccess: (res) => {
          // OM-12: a partial multi-store send keeps only the failures ticked.
          const outcome = describeSendResult(res, ids.length, "item");
          if (outcome.partial) {
            toast.warning(outcome.message);
            setPicked(new Set(outcome.failedIds));
            return;
          }
          toast.success(
            `Offer sent to watchers on ${res.count} item${res.count === 1 ? "" : "s"}.`,
          );
          setPicked(new Set());
        },
        onError: (err) => toastError(err, "The offer did not send."),
      },
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Watchers worth an offer</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }
  // OM-12: a failed load says so. It used to render nothing, which reads as
  // "no watchers worth an offer".
  if (isError && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Watchers worth an offer</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorState
            className="py-4"
            hideSupport
            title="Couldn't load today's candidates"
            onRetry={() => refetch()}
            retrying={isFetching}
          />
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  // Gated, not broken. Say what is wrong and what to do instead, together.
  if (!data.available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Watchers worth an offer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">{data.detail}</p>
          {data.fallback && (
            <p className="text-sm text-muted-foreground">
              {data.fallback.detail}{" "}
              <Link className="underline" to={data.fallback.href}>
                Set up a sale
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (data.candidates.length === 0 && data.suppressed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No watchers to offer today. Listings with watchers and no recent offer show
        up here.
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4" />
          Watchers worth an offer
        </CardTitle>
        <CardDescription>
          People watching these have not bought yet. Most watched first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Label htmlFor="offer-discount">Discount</Label>
          <Input
            id="offer-discount"
            type="number"
            inputMode="numeric"
            min={SEND_OFFER_MIN_PCT}
            max={SEND_OFFER_MAX_PCT}
            step={1}
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            aria-invalid={pct == null ? true : undefined}
            aria-describedby={pct == null ? "offer-discount-range" : undefined}
            className="h-8 w-20"
          />
          %
          {pct == null && (
            <span id="offer-discount-range" className="text-xs font-medium text-destructive">
              {SEND_OFFER_RANGE_COPY}
            </span>
          )}
          <Button
            size="sm"
            className="ml-auto"
            disabled={selected.length === 0 || pct == null || send.isPending}
            onClick={sendSelected}
          >
            {send.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {selected.length === 0
              ? "Pick items to send"
              : pct == null
                ? "Send offer"
                : `Send ${pct}% off to ${selected.length}`}
          </Button>
        </div>

        <ul className="space-y-1">
          {data.candidates.map((c) => (
            <li key={c.listingId} className="flex items-center gap-2 rounded-md border p-2">
              <Checkbox
                id={`cand-${c.listingId}`}
                checked={picked.has(c.listingId)}
                onCheckedChange={(v) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(c.listingId);
                    else next.delete(c.listingId);
                    return next;
                  })}
              />
              <Label htmlFor={`cand-${c.listingId}`} className="min-w-0 flex-1 font-normal">
                <span className="block truncate text-sm">{c.title || c.listingId}</span>
                <span className="block text-xs text-muted-foreground">
                  {c.watchers} watcher{c.watchers === 1 ? "" : "s"}
                  {c.daysListed != null ? ` · listed ${c.daysListed}d` : ""}
                  {c.priceCents != null ? ` · ${money(c.priceCents)}` : ""}
                </span>
              </Label>
            </li>
          ))}
        </ul>

        {/* The suppressed set is shown, not hidden. A seller who cannot find an
            item they expected here would otherwise assume it is ineligible. */}
        {data.suppressed.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {data.suppressed.length} more had an offer in the last{" "}
            {data.cooldownDays ?? 7} days and are being held back. Offering the same
            watchers every week teaches them to wait for the next discount.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
