import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, MapPin, Package, Truck } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { toastError } from "@/lib/toast-error";
import { useShipQueue, type ShipQueueRow } from "@/hooks/use-ship-queue";
import { shipCountdown, type ShipUrgency } from "@/pages/flipdesk/ship-queue";
import { useEbayShipOrder } from "@/hooks/use-ebay";

// US-3190: the orders waiting to go in a box, soonest deadline first.
//
// This is the queue the seller is SCORED on. Every other card on this page is
// eBay asking a question; this one is a clock the seller loses by not looking,
// and until now the product had no screen that counted down to it.
//
// ── COLOR IS NOT THE SIGNAL ─────────────────────────────────────────────────
//
// WCAG 1.4.1: an overdue row carries a word ("Overdue by 2 days") and an icon,
// not just a red badge. A seller reading this on a phone in a garage, or with
// any red-green deficiency, gets the same answer as everyone else.
//
// ── ONE MUTATION, NOT TWO ───────────────────────────────────────────────────
//
// Submitting tracking calls the same /orders/:saleId/ship route the item canvas
// uses. That route writes shipped_at AND pushes the fulfillment to eBay in one
// step, so a row cannot leave this queue locally while eBay still shows it
// unshipped — which is exactly the split a second write path would create.

const URGENCY_STYLE: Record<ShipUrgency, string> = {
  overdue: "border-destructive/40 bg-destructive/10 text-destructive",
  today: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  tomorrow: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400",
  later: "border-border bg-muted text-muted-foreground",
  none: "border-border bg-muted text-muted-foreground",
};

function ShipRow({ row }: { row: ShipQueueRow }) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const ship = useEbayShipOrder();
  const qc = useQueryClient();
  const countdown = shipCountdown(row.shipBy);

  async function submit() {
    const value = tracking.trim();
    if (!value) {
      toast.error("Enter a tracking number first.");
      return;
    }
    try {
      await ship.mutateAsync({
        saleId: row.id,
        trackingNumber: value,
        carrier: carrier.trim() || null,
      });
      toast.success("Marked shipped.");
      // The row leaves this queue because shipped_at is now set; the needs-you
      // merge reads the same query, so both surfaces update from one refetch.
      await qc.invalidateQueries({ queryKey: ["ship_queue"] });
    } catch (err) {
      toastError(err, "Could not mark it shipped.");
    }
  }

  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {row.title ?? `Order ${row.orderRef ?? row.id}`}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {row.orderRef ? <span>Order {row.orderRef}</span> : null}
            {row.sku ? <span>SKU {row.sku}</span> : null}
            {row.size ? <span>Size {row.size}</span> : null}
            {row.locationBin ? (
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <MapPin aria-hidden="true" className="h-3 w-3" />
                {row.locationBin}
              </span>
            ) : null}
          </p>
        </div>
        <Badge
          variant="outline"
          className={`shrink-0 gap-1 ${URGENCY_STYLE[countdown.urgency]}`}
        >
          {countdown.urgency === "overdue" ? (
            <AlertTriangle aria-hidden="true" className="h-3 w-3" />
          ) : null}
          {countdown.label}
        </Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[10rem] flex-1">
          <Label htmlFor={`tracking-${row.id}`} className="text-xs">
            Tracking number
          </Label>
          <Input
            id={`tracking-${row.id}`}
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            placeholder="9400 1000 0000 0000 0000 00"
            autoComplete="off"
          />
        </div>
        <div className="w-28">
          <Label htmlFor={`carrier-${row.id}`} className="text-xs">
            Carrier
          </Label>
          <Input
            id={`carrier-${row.id}`}
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
            placeholder="USPS"
            autoComplete="off"
          />
        </div>
        <Button
          type="button"
          onClick={submit}
          disabled={ship.isPending}
          className="gap-1"
        >
          <Truck aria-hidden="true" className="h-4 w-4" />
          {ship.isPending ? "Marking…" : "Mark shipped"}
        </Button>
      </div>
    </li>
  );
}

export function ShipQueueCard() {
  const { rows, isLoading, isError } = useShipQueue();
  const overdue = rows.filter(
    (r) => shipCountdown(r.shipBy).urgency === "overdue",
  ).length;

  return (
    <Card id="ship-queue" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package aria-hidden="true" className="h-4 w-4" />
          Waiting to ship
          {overdue > 0 ? (
            <Badge variant="destructive">{overdue} overdue</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Sold and not yet in a carrier's hands, soonest deadline first. Orders
          no marketplace set a deadline for sit at the bottom.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Could not load the ship queue. Reload the page to try again.
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Package}
            title="Nothing waiting to ship"
            description="Every completed sale has a tracking number on it."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <ShipRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
