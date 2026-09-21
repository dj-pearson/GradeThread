import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError, toastWarning } from "@/lib/toast-error";
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
  useEasyPostOnboard,
  useEbayLogisticsCapability,
  useEbayReprintLabel,
  useEbayShipOrder,
  useEbayShippingRates,
} from "@/hooks/use-ebay";
import { useLatestRun } from "@/hooks/use-latest-run";
import { acceptRateQuote } from "@/components/flipdesk/ship-rate-quote";
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
//
// US-3011: with ONE exception. `plan_locked` means the seller's plan doesn't
// include label buying, which is the only unavailable state they can fix, so it
// shows an upgrade prompt instead of hiding. Hiding it would be the same
// mistake in reverse — a Pro feature nobody on Starter ever discovers.
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
  // Only `plan_locked` gets a prompt. `feature_unavailable` and
  // `reconnect_required` are not things an upgrade fixes, and offering to sell
  // Pro for either would be a lie.
  const labelsPlanLocked = capability.data?.code === "plan_locked";
  // US-3015: the second state a seller can fix themselves, and the fix is at
  // EasyPost rather than here. Hiding on it would leave a working feature
  // permanently switched off for every non-eBay sale -- the same mistake
  // plan_locked's exception exists to avoid.
  const easypostOnboarding =
    capability.data?.code === "easypost_onboarding_required";
  const usesEasyPost = capability.data?.provider === "easypost";
  const onboardEasyPost = useEasyPostOnboard();
  const [shipTo, setShipTo] = useState({
    name: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
  });
  // Line 2 and the name are genuinely optional; the other four are what any
  // carrier needs to quote at all, and a partial address comes back from
  // EasyPost as an opaque 422.
  const shipToComplete =
    shipTo.line1.trim() !== "" &&
    shipTo.city.trim() !== "" &&
    shipTo.state.trim() !== "" &&
    shipTo.postalCode.trim() !== "";
  const rates = useEbayShippingRates();
  const buyLabel = useEbayBuyLabel();
  const reprint = useEbayReprintLabel();
  // US-3223: ownership of the quote that Buy submits. See ship-rate-quote.ts.
  const quoteRuns = useLatestRun();
  const [weight, setWeight] = useState("1");
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [rateOptions, setRateOptions] = useState<EbayShippingRate[]>([]);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [labelUrl, setLabelUrl] = useState<string | null>(null);

  useEffect(() => {
    if (item) {
      // US-3223: a rate-shop for the PREVIOUS order can still be in flight here.
      // Clearing the quote is not enough -- without this the old response lands
      // afterwards and re-arms Buy with another order's quote id.
      quoteRuns.supersede();
      setTracking("");
      setCarrier("USPS");
      setWeight("1");
      setQuoteId(null);
      setRateOptions([]);
      setSelectedRateId(null);
      setLabelUrl(null);
    }
    // quoteRuns is a stable ref-backed owner; it never changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // US-3223: "Get rates" is disabled while the RATE call is pending, but
    // loadSale() runs first and the button is live for that whole round trip.
    // Two clicks at two weights leaves two quotes racing, and the older one
    // landing last would hand Buy a quote id for a parcel weight the seller has
    // already changed. See ship-rate-quote.ts.
    const run = quoteRuns.begin();
    try {
      const sale = await loadSale();
      if (!sale) {
        toast.error("Couldn't find the sale for this item.");
        return;
      }
      // US-3015: an eBay order is required only on the eBay path. EasyPost
      // prices any sale at all, which is the whole reason it is here -- so
      // refusing on a missing eBay order would keep the fallback unreachable
      // for exactly the sales it was added to serve.
      if (!usesEasyPost && !sale.platform_order_id) {
        toast.error("This sale has no eBay order, so there's no label to buy.");
        return;
      }
      if (usesEasyPost && !shipToComplete) {
        toast.error("Add the buyer's shipping address to price this label.");
        return;
      }
      const quote = await rates.mutateAsync({
        saleId: sale.id,
        parcel: { weightValue: w },
        shipTo: usesEasyPost
          ? {
              name: shipTo.name.trim() || null,
              line1: shipTo.line1.trim(),
              line2: shipTo.line2.trim() || null,
              city: shipTo.city.trim(),
              state: shipTo.state.trim(),
              postalCode: shipTo.postalCode.trim(),
            }
          : null,
      });
      const patch = acceptRateQuote(run, quote);
      if (!patch) return;
      setQuoteId(patch.quoteId);
      setRateOptions(patch.rateOptions);
      setSelectedRateId(patch.selectedRateId);
      if (quote.rates.length === 0) {
        toast.error("No rates came back for this parcel.");
      }
    } catch (err) {
      if (run.superseded) return;
      const e = err as Error & { code?: string };
      toastError(
        e,
        e.code === "ship_from_missing" || e.code === "ship_to_missing" ||
          e.code === "easypost_onboarding_required"
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
      //
      // US-3376: this result used to be dropped, and it is the one write here
      // that nothing else covers. The sale row above IS checked and throws, so
      // a failure on THIS line was invisible: eBay had the tracking, the sale
      // recorded shipped_at, the toast said "Marked shipped" and the garment
      // stayed in the ship queue forever with nothing to say why.
      const { error: statusErr } = await supabase
        .from("inventory_items")
        .update({ status: "shipped" } as never)
        .eq("id", item.id);
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      if (statusErr) {
        // NOT a plain failure, and not the catch below: the shipment really did
        // happen. Name the half that landed, name the half that did not, and
        // leave the dialog open so pressing the button again is the fix.
        toastWarning(
          statusErr,
          pushed
            ? "Tracking sent to eBay, but the item is still in the ship queue."
            : "Shipment recorded, but the item is still in the ship queue.",
          {
            action: "mark item shipped",
            duration: 10_000,
            nextStep: "Press Mark shipped again to move it out of the queue.",
          },
        );
        return;
      }
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
          {labelsPlanLocked && (
            <div className="space-y-2 rounded-lg bg-muted/50 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Tag className="h-4 w-4" />
                Buy labels here on Pro
              </div>
              <p className="text-sm text-muted-foreground">
                {capability.data?.detail ??
                  "Buying shipping labels here is part of Pro."}{" "}
                Postage is the carrier's own rate. We don't add anything to
                it.
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link to="/pricing">See plans</Link>
              </Button>
            </div>
          )}
          {easypostOnboarding && (
            <div className="space-y-2 rounded-lg bg-muted/50 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Tag className="h-4 w-4" />
                Set up postage
              </div>
              <p className="text-sm text-muted-foreground">
                {capability.data?.detail ??
                  "Add a card with EasyPost to buy postage here."}{" "}
                You pay EasyPost at the carrier's rate. We never handle the
                postage money, and we add nothing to it.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={onboardEasyPost.isPending}
                onClick={() => {
                  onboardEasyPost.mutate(undefined, {
                    onSuccess: (r) =>
                      toast.success(
                        r.ready
                          ? "EasyPost is ready. You can buy a label now."
                          : "EasyPost account created. Add your card with EasyPost to finish."
                      ),
                    onError: (e) => toastError(e, "Couldn't set up EasyPost."),
                  });
                }}
              >
                {onboardEasyPost.isPending
                  ? "Setting up…"
                  : capability.data?.easypost.onboarded
                    ? "Check again"
                    : "Set up EasyPost"}
              </Button>
            </div>
          )}
          {canBuyLabels && (
            <div className="space-y-3 rounded-lg bg-muted/50 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Tag className="h-4 w-4" />
                Buy a label
              </div>
              {usesEasyPost && (
                <div className="space-y-2">
                  {/* US-3015: eBay derives the destination from the order, so
                      that path never asks. EasyPost has no order to derive
                      from. This address is sent for the rate call and stored
                      nowhere -- it is the buyer's home. */}
                  <Label htmlFor="ship-to-line1">Ship to</Label>
                  <Input
                    id="ship-to-name"
                    aria-label="Ship to name"
                    placeholder="Name (optional)"
                    value={shipTo.name}
                    onChange={(e) =>
                      setShipTo((p) => ({ ...p, name: e.target.value }))
                    }
                  />
                  <Input
                    id="ship-to-line1"
                    aria-label="Ship to street address"
                    placeholder="Street address"
                    value={shipTo.line1}
                    onChange={(e) =>
                      setShipTo((p) => ({ ...p, line1: e.target.value }))
                    }
                  />
                  <Input
                    id="ship-to-line2"
                    aria-label="Ship to apartment or suite"
                    placeholder="Apt, suite (optional)"
                    value={shipTo.line2}
                    onChange={(e) =>
                      setShipTo((p) => ({ ...p, line2: e.target.value }))
                    }
                  />
                  <div className="flex gap-2">
                    <Input
                      id="ship-to-city"
                      aria-label="Ship to city"
                      placeholder="City"
                      value={shipTo.city}
                      onChange={(e) =>
                        setShipTo((p) => ({ ...p, city: e.target.value }))
                      }
                    />
                    <Input
                      id="ship-to-state"
                      aria-label="Ship to state"
                      className="w-20"
                      placeholder="State"
                      value={shipTo.state}
                      onChange={(e) =>
                        setShipTo((p) => ({ ...p, state: e.target.value }))
                      }
                    />
                    <Input
                      id="ship-to-postal"
                      aria-label="Ship to ZIP code"
                      className="w-28"
                      placeholder="ZIP"
                      value={shipTo.postalCode}
                      onChange={(e) =>
                        setShipTo((p) => ({ ...p, postalCode: e.target.value }))
                      }
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    We send this to the carrier to price and print the label. We
                    don't keep it.
                  </p>
                </div>
              )}
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
                  disabled={
                    rates.isPending ||
                    buyLabel.isPending ||
                    // US-3015: on the EasyPost path there is nowhere to
                    // ship to until the seller types one, and a rate call
                    // without it comes back as a 409 they have to read.
                    (usesEasyPost && !shipToComplete)
                  }
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
