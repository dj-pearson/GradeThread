import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { edgeFetch } from "@/lib/edge-fetch";

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

interface Candidate {
  listingId: string;
  title: string | null;
  priceCents: number | null;
  watchers: number;
  daysListed: number | null;
  lastOfferedAt: string | null;
}

interface TodayResponse {
  available: boolean;
  detail?: string;
  fallback?: { kind: string; detail: string; href: string };
  cooldownDays?: number;
  discountPct?: number;
  candidates: Candidate[];
  suppressed: Candidate[];
  exposureCents?: number | null;
}

function money(cents: number | null | undefined): string {
  return cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;
}

export function SendOffersToday() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [discount, setDiscount] = useState("10");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const pct = Math.min(Math.max(Number(discount) || 10, 1), 60);
  const { data, isLoading } = useQuery({
    queryKey: ["ebay_send_offers_today", pct],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TodayResponse> => {
      const res = await edgeFetch(
        `/api/flipdesk/ebay/negotiation/send-offer-today?discount_pct=${pct}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load today's offer candidates.");
      return json as TodayResponse;
    },
  });

  const send = useMutation<{ count: number }, Error, { ids: string[] }>({
    mutationFn: async ({ ids }) => {
      const res = await edgeFetch("/api/flipdesk/ebay/negotiation/send-offer", {
        method: "POST",
        body: JSON.stringify({ listing_ids: ids, discount_percentage: String(pct) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.detail || json.error || "eBay rejected the offer.");
      return json;
    },
    onSuccess: (res) => {
      toast.success(`Offer sent to watchers on ${res.count} item${res.count === 1 ? "" : "s"}.`);
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ["ebay_send_offers_today"] });
    },
    onError: (err) => toastError(err, "The offer did not send."),
  });

  const selected = useMemo(
    () => (data?.candidates ?? []).filter((c) => picked.has(c.listingId)),
    [data, picked],
  );
  // The worst case for the SELECTION, recomputed here rather than reusing the
  // whole-list figure the server sent — a seller who ticked four of forty items
  // must not be shown the exposure of all forty.
  const selectedExposure = selected.every((c) => c.priceCents != null)
    ? selected.reduce((sum, c) => sum + Math.round((c.priceCents ?? 0) * (pct / 100)), 0)
    : null;

  async function sendSelected() {
    if (selected.length === 0) return;
    const ok = await confirm({
      title: `Send ${pct}% off to ${selected.length} item${selected.length === 1 ? "" : "s"}?`,
      description: selectedExposure == null
        ? "Some of these have no price on record, so we can't total what this could cost. Offers go to everyone watching them and can be accepted immediately."
        : `If every one is accepted this gives away ${money(selectedExposure)}. Offers go to everyone watching and can be accepted immediately.`,
      confirmLabel: "Send offers",
    });
    if (!ok) return;
    send.mutate({ ids: selected.map((c) => c.listingId) });
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
              <a className="underline" href={data.fallback.href}>
                Set up a sale
              </a>
              .
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (data.candidates.length === 0 && data.suppressed.length === 0) return null;

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
            min={1}
            max={60}
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            className="h-8 w-20"
          />
          %
          <Button
            size="sm"
            className="ml-auto"
            disabled={selected.length === 0 || send.isPending}
            onClick={sendSelected}
          >
            {send.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Send to {selected.length || "…"}
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
