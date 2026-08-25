import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Loader2, Printer, Tag, Truck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import {
  type EbayShippingRate,
  useEbayBuyLabel,
  useEbayLogisticsCapability,
  useEbayReprintLabel,
  useEbayShipOrder,
  useEbayShippingRates,
} from "@/hooks/use-ebay";
import type { ItemFullRow } from "@/types/database";

// US-1039: mark a sold order shipped and push the tracking number + carrier to
// eBay (Sell Fulfillment API) so the buyer sees tracking and the order shows
// Shipped. For an eBay order this calls the ship route (which also records
// shipped_at + tracking server-side); for a manual/other-marketplace sale (the
// route returns 409) it records shipping locally. Either way the item moves to
// the Shipped tab.
//
// US-2160: when the deployment can buy eBay labels, the dialog leads with
// "Buy a label" — rate-shop, purchase, and the tracking number fills itself in.
// Typing a tracking number by hand stays available underneath for postage bought
// elsewhere. The buy path is hidden entirely when the capability is off, rather
// than shown and then failing at checkout.
const CARRIERS = ["USPS", "UPS", "FedEx", "DHL", "Other"] as const;

function money(cents: number | null | undefined, currency: string | null): string {
  if (cents == null) return "price unavailable";
  const amount = (cents / 100).toFixed(2);
  return currency && currency !== "USD" ? `${amount} ${currency}` : `$${amount}`;
}

function deliveryEstimate(rate: EbayShippingRate): string | null {
  const d = rate.maxDeliveryDate ?? rate.minDeliveryDate;
  if (!d) return null;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ShipOrderDialog({
  item,
  onClose,
}: {
  item: ItemFullRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const ship = useEbayShipOrder();
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState<string>("USPS");
  const [busy, setBusy] = useState(false);

  // ── US-2160: buy-a-label ──────────────────────────────────────
  const capability = useEbayLogisticsCapability(!!item);
  const canBuyLabels = capability.data?.labelPurchaseAvailable === true;
  const rates = useEbayShippingRates();
  const buyLabel = useEbayBuyLabel();
  const reprint = useEbayReprintLabel();
  const [weight, setWeight] = useState("1");
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [rateOptions, setRateOptions] = useState<EbayShippingRate[]>([]);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [labelUrl, setLabelUrl] = useState<string | null>(null);

  useEffect(() => {
    if (item) {
      setTracking("");
      setCarrier("USPS");
      setWeight("1");
      setQuoteId(null);
      setRateOptions([]);
      setSelectedRateId(null);
      setLabelUrl(null);
    }
  }, [item]);

  // The item's most-recent sale — both the label flow and the manual flow need
  // its id, and the label flow additionally needs it to be an eBay order.
  async function loadSale(): Promise<
    { id: string; platform_order_id: string | null } | null
  > {
    if (!item) return null;
    const { data, error } = await supabase
      .from("sales")
      .select("id, platform_order_id")
      .eq("inventory_item_id", item.id)
      .order("sale_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as { id: string; platform_order_id: string | null } | null) ?? null;
  }

  async function fetchRates() {
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) {
      toast.error("Enter a parcel weight above zero.");
      return;
    }
    try {
      const sale = await loadSale();
      if (!sale?.platform_order_id) {
        toast.error("This sale has no eBay order, so there's no label to buy.");
        return;
      }
      const quote = await rates.mutateAsync({
        saleId: sale.id,
        parcel: { weightValue: w },
      });
      setQuoteId(quote.shippingQuoteId);
      setRateOptions(quote.rates);
      // Preselect the cheapest KNOWN price so the common case is one click —
      // but never auto-buy; the seller still confirms.
      const priced = quote.rates.filter((r) => r.totalCostCents != null);
      const cheapest = priced.reduce<EbayShippingRate | null>(
        (best, r) =>
          best == null || r.totalCostCents! < best.totalCostCents! ? r : best,
        null,
      );
      setSelectedRateId(cheapest?.rateId ?? null);
      if (quote.rates.length === 0) {
        toast.error("eBay returned no rates for this parcel.");
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      toastError(
        e,
        e.code === "ship_from_missing"
          ? e.message
          : "Couldn't get shipping rates.",
        { duration: 10_000 },
      );
    }
  }

  async function purchase() {
    if (!quoteId || !selectedRateId) return;
    try {
      const sale = await loadSale();
      if (!sale) return;
      const bought = await buyLabel.mutateAsync({
        saleId: sale.id,
        shippingQuoteId: quoteId,
        rateId: selectedRateId,
      });
      if (bought.tracking_number) setTracking(bought.tracking_number);
      if (bought.carrier) setCarrier(bought.carrier);
      setLabelUrl(bought.label_download_url ?? null);
      setRateOptions([]);
      toast.success(
        bought.already_purchased
          ? "A label was already bought for this sale."
          : bought.marked_shipped_on_ebay
            ? "Label bought — tracking sent to eBay."
            : "Label bought.",
      );
      await qc.invalidateQueries({ queryKey: ["items_full"] });
    } catch (err) {
      toastError(err, "Couldn't buy the label.", { duration: 10_000 });
    }
  }

  async function reprintLabel() {
    try {
      const sale = await loadSale();
      if (!sale) return;
      const again = await reprint.mutateAsync({ saleId: sale.id });
      setLabelUrl(again.label_download_url ?? null);
      if (!again.label_download_url) toast.error("eBay returned no label link.");
    } catch (err) {
      toastError(err, "Couldn't fetch the label.");
    }
  }

  if (!item) return null;

  async function submit() {
    if (!item) return;
    const tn = tracking.trim();
    if (!tn) {
      toast.error("Enter a tracking number.");
      return;
    }
    setBusy(true);
    try {
      // ItemFullRow has no sale id — look up the item's most recent sale to get
      // its id + whether it's an eBay order (platform_order_id).
      const { data: saleRow, error: saleErr } = await supabase
        .from("sales")
        .select("id, platform_order_id")
        .eq("inventory_item_id", item.id)
        .order("sale_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (saleErr) throw saleErr;
      const sale = saleRow as
        | { id: string; platform_order_id: string | null }
        | null;

      let pushed = false;
      if (sale?.platform_order_id) {
        // eBay order — push tracking to eBay (also records shipped_at + tracking
        // server-side).
        const res = await ship.mutateAsync({
          saleId: sale.id,
          trackingNumber: tn,
          carrier,
        });
        pushed = res.pushed_to_ebay;
      } else if (sale) {
        // Manual / other-marketplace sale — record shipping locally.
        const { error } = await supabase
          .from("sales")
          .update({
            shipped_at: new Date().toISOString(),
            tracking_number: tn,
            // US-960: persist the carrier (column added in 00250).
            carrier,
          } as never)
          .eq("id", sale.id);
        if (error) throw error;
      }

      // Move the item to the Shipped tab (web's item-status model).
      await supabase
        .from("inventory_items")
        .update({ status: "shipped" } as never)
        .eq("id", item.id);
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(
        pushed ? "Marked shipped — tracking sent to eBay." : "Marked shipped.",
      );
      onClose();
    } catch (err) {
      const e = err as Error & { status?: number };
      toastError(
        e,
        e.status === 502
          ? "eBay rejected the tracking number."
          : "Couldn't mark this shipped.",
        { duration: 10_000 },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark shipped</DialogTitle>
          <DialogDescription>
            Records the shipment and, for an eBay order, pushes the tracking
            number + carrier to eBay so the buyer sees tracking.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* US-2160: buy the postage here. Hidden entirely when the
              deployment/connection can't — an entry point that always fails is
              worse than none. */}
          {canBuyLabels && (
            <div className="space-y-3 rounded-lg bg-muted/50 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Tag className="h-4 w-4" />
                Buy a label
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Label htmlFor="ship-weight">Parcel weight (lb)</Label>
                  <Input
                    id="ship-weight"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                  />
                </div>
                <Button
                  variant="secondary"
                  onClick={fetchRates}
                  disabled={rates.isPending || buyLabel.isPending}
                >
                  {rates.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Get rates
                </Button>
              </div>

              {rateOptions.length > 0 && (
                <div className="space-y-2">
                  <div className="space-y-1">
                    {rateOptions.map((r) => {
                      const eta = deliveryEstimate(r);
                      const buyable = r.totalCostCents != null;
                      return (
                        <label
                          key={r.rateId}
                          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                            selectedRateId === r.rateId
                              ? "bg-background"
                              : "hover:bg-background/60"
                          } ${buyable ? "" : "opacity-60"}`}
                        >
                          <input
                            type="radio"
                            name="ship-rate"
                            value={r.rateId}
                            checked={selectedRateId === r.rateId}
                            onChange={() => setSelectedRateId(r.rateId)}
                            /* A rate whose price eBay didn't return can't be
                               recorded as a cost, so it isn't selectable. */
                            disabled={!buyable}
                          />
                          <span className="flex-1 truncate">
                            {[r.carrier, r.serviceName]
                              .filter(Boolean)
                              .join(" ") || "Shipping service"}
                            {eta && (
                              <span className="text-muted-foreground">
                                {" "}
                                &middot; by {eta}
                              </span>
                            )}
                          </span>
                          <span className="font-medium tabular-nums">
                            {money(r.totalCostCents, r.currency)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <Button
                    className="w-full"
                    onClick={purchase}
                    disabled={!selectedRateId || buyLabel.isPending}
                  >
                    {buyLabel.isPending && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Buy this label
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    eBay charges your seller account. The postage is recorded as
                    this sale&rsquo;s shipping cost.
                  </p>
                </div>
              )}

              {labelUrl && (
                <div className="flex items-center gap-2">
                  <Button asChild variant="secondary" className="flex-1">
                    <a href={labelUrl} target="_blank" rel="noopener noreferrer">
                      <Printer className="mr-2 h-4 w-4" />
                      Open label
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    onClick={reprintLabel}
                    disabled={reprint.isPending}
                    title="eBay label links expire — this fetches a fresh one."
                  >
                    {reprint.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Refresh link"
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="ship-carrier">Carrier</Label>
            <select
              id="ship-carrier"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {CARRIERS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ship-tracking">Tracking number</Label>
            <Input
              id="ship-tracking"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              placeholder="e.g. 9400 1000 0000 0000 0000 00"
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Truck className="mr-2 h-4 w-4" />
            )}
            Mark shipped
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
