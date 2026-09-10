import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ExternalLink,
  MapPin,
  Package,
  Printer,
  Truck,
} from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { toastError } from "@/lib/toast-error";
import { useShipQueue, type ShipQueueRow } from "@/hooks/use-ship-queue";
import {
  shipCountdown,
  shipOneOrder,
  type ShipUrgency,
} from "@/pages/flipdesk/ship-queue";
import { supabase } from "@/lib/supabase";
import { useEbayShipOrder } from "@/hooks/use-ebay";
import { Checkbox } from "@/components/ui/checkbox";
import { packingSlipDocument } from "@/pages/flipdesk/packing-slip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Dollars, the way the rest of post-sale.tsx writes them. */
function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

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
//
// ── AND THE ORDER THAT IS NOT eBay'S ────────────────────────────────────────
//
// That route is right for an eBay order and refuses every other kind: 409 when
// the sale has no platform_order_id, 503 when the deployment has no eBay
// credentials at all. This queue holds EVERY completed unshipped sale and
// renders in post-sale.tsx's not-connected branch, so both refusals land on
// real sellers with real tracking numbers. shipOneOrder picks the path (see
// pages/flipdesk/ship-queue.ts); the local write mirrors what the route writes
// server-side — shipped_at, tracking_number, carrier — and nothing else, so the
// two paths cannot leave a sale in different shapes.

const URGENCY_STYLE: Record<ShipUrgency, string> = {
  overdue: "border-destructive/40 bg-destructive/10 text-destructive",
  today: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  tomorrow: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400",
  later: "border-border bg-muted text-muted-foreground",
  none: "border-border bg-muted text-muted-foreground",
};

function ShipRow({
  row,
  selected,
  onSelect,
}: {
  row: ShipQueueRow;
  selected: boolean;
  onSelect: (id: string, next: boolean) => void;
}) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [busy, setBusy] = useState(false);
  const ship = useEbayShipOrder();
  const qc = useQueryClient();
  const countdown = shipCountdown(row.shipBy);
  const isEbayOrder = (row.orderRef ?? "").trim() !== "";

  async function submit() {
    const value = tracking.trim();
    if (!value) {
      toast.error("Enter the tracking number first.");
      return;
    }
    // `busy` rather than ship.isPending: the local path never touches that
    // mutation, so the button would stay live through the whole write.
    setBusy(true);
    try {
      const path = await shipOneOrder(row.orderRef, {
        pushToEbay: async () => {
          await ship.mutateAsync({
            saleId: row.id,
            trackingNumber: value,
            carrier: carrier.trim() || null,
          });
        },
        writeLocal: async () => {
          const { error } = await supabase
            .from("sales")
            .update({
              shipped_at: new Date().toISOString(),
              tracking_number: value,
              // Keep an existing carrier when the seller left the box empty,
              // the same way the ship route does.
              ...(carrier.trim() ? { carrier: carrier.trim() } : {}),
            } as never)
            .eq("id", row.id);
          if (error) throw error;
        },
      });
      toast.success(
        path === "ebay"
          ? "Marked shipped, and the tracking is on eBay."
          : "Marked shipped.",
      );
      // The row leaves this queue because shipped_at is now set; the needs-you
      // merge reads the same query, so both surfaces update from one refetch.
      await qc.invalidateQueries({ queryKey: ["ship_queue"] });
    } catch (err) {
      toastError(err, "Could not mark it shipped.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="w-8 align-top">
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onSelect(row.id, v === true)}
          aria-label={`Select ${row.title ?? row.orderRef ?? "this order"} for a packing slip`}
        />
      </TableCell>

      <TableCell className="min-w-[14rem] align-top">
        <div className="font-medium">
          {row.listingUrl ? (
            // US-3205: the name IS the link. A separate control would be a
            // second thing to aim at on a row that already has a checkbox, two
            // inputs and a button.
            <a
              href={row.listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:underline"
            >
              <span className="line-clamp-2">
                {row.title ?? `Order ${row.orderRef ?? row.id}`}
              </span>
              <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <span className="line-clamp-2">
              {row.title ?? `Order ${row.orderRef ?? row.id}`}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {row.sku ? <span>SKU {row.sku}</span> : null}
          {row.size ? <span>Size {row.size}</span> : null}
          {row.orderRef ? <span>Order {row.orderRef}</span> : null}
        </div>
      </TableCell>

      <TableCell className="align-top text-xs">
        {/* The shelf and the tote answer different questions, so both show. */}
        <div className="flex flex-col gap-0.5">
          {row.locationBin ? (
            <span className="inline-flex items-center gap-1 font-medium">
              <MapPin aria-hidden="true" className="h-3 w-3" />
              {row.locationBin}
            </span>
          ) : null}
          {row.container ? (
            <span className="inline-flex items-center gap-1 font-medium">
              <Package aria-hidden="true" className="h-3 w-3" />
              {row.container}
            </span>
          ) : null}
          {!row.locationBin && !row.container ? (
            <span className="text-muted-foreground">&mdash;</span>
          ) : null}
        </div>
      </TableCell>

      <TableCell className="align-top text-right text-xs tabular-nums">
        {row.salePrice != null ? <div>{money(row.salePrice)}</div> : null}
        {row.costBasis != null ? (
          <div className="text-muted-foreground">
            paid {money(row.costBasis)}
          </div>
        ) : null}
        {row.net != null ? (
          <div
            className={
              row.net < 0
                ? "font-medium text-destructive"
                : "font-medium text-emerald-600 dark:text-emerald-400"
            }
            // Every row here is unshipped, so the label has not been bought and
            // its cost is not in the figure. Saying so beats a seller finding
            // out at payout.
            title="Estimated. Postage is not in this figure until the label is bought."
          >
            {money(row.net)} est.
          </div>
        ) : null}
      </TableCell>

      <TableCell className="align-top">
        <Badge
          variant="outline"
          className={`gap-1 whitespace-nowrap ${URGENCY_STYLE[countdown.urgency]}`}
        >
          {countdown.urgency === "overdue" ? (
            <AlertTriangle aria-hidden="true" className="h-3 w-3" />
          ) : null}
          {countdown.label}
        </Badge>
      </TableCell>

      <TableCell className="align-top">
        <div className="flex items-center gap-1.5">
          <Input
            aria-label={`Tracking number for ${row.title ?? row.orderRef ?? "this order"}`}
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            placeholder="Tracking number"
            autoComplete="off"
            className="h-8 min-w-[11rem] text-xs"
          />
          <Input
            aria-label={`Carrier for ${row.title ?? row.orderRef ?? "this order"}`}
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
            placeholder="USPS"
            autoComplete="off"
            className="h-8 w-20 text-xs"
          />
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={busy}
            className="h-8 gap-1 whitespace-nowrap"
            // US-3209: name what the button DOES, because it does two things and
            // the seller can only see one of them. It writes the tracking here
            // AND uploads the fulfillment to eBay in the same call \u2014 except on
            // a sale eBay never had, where saying so would be a lie.
            title={
              isEbayOrder
                ? "Saves the tracking here and uploads it to eBay in one step."
                : "Saves the tracking here. This order has no eBay reference, so there is nothing to upload."
            }
          >
            <Truck aria-hidden="true" className="h-3.5 w-3.5" />
            {busy ? "Saving\u2026" : "Ship"}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ShipQueueCard() {
  const { rows, isLoading, isError } = useShipQueue();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const overdue = rows.filter(
    (r) => shipCountdown(r.shipBy).urgency === "overdue",
  ).length;

  function toggle(id: string, next: boolean) {
    setSelected((prev) => {
      const out = new Set(prev);
      if (next) out.add(id);
      else out.delete(id);
      return out;
    });
  }

  function printSlips() {
    const chosen = rows.filter((r) => selected.has(r.id));
    if (chosen.length === 0) {
      toast.error("Tick the orders you are packing first.");
      return;
    }
    const win = window.open("", "_blank");
    if (!win) {
      toast.error("Allow popups to print packing slips.");
      return;
    }
    win.document.write(packingSlipDocument(chosen));
    win.document.close();
    // The same delay pnl.tsx uses: print() before the document settles gives a
    // blank first page in Safari.
    setTimeout(() => win.print(), 500);
  }

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
        {rows.length > 0 ? (
          <div className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={printSlips}
              className="gap-1"
            >
              <Printer aria-hidden="true" className="h-4 w-4" />
              Print packing slips
              {selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          </div>
        ) : null}
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
          /* A table, because this is a list a seller SCANS. The card stack
             made every row a paragraph, so comparing two deadlines or spotting
             which order is in the wrong tote meant reading prose; a grid puts
             the same facts in columns that line up.

             Its own horizontal scroller: six columns and two inputs do not fit
             a phone, and the page body must never scroll sideways. */
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Item</TableHead>
                  <TableHead>Where</TableHead>
                  <TableHead className="text-right">Sold / net</TableHead>
                  <TableHead>Ship by</TableHead>
                  <TableHead>Tracking</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <ShipRow
                    key={row.id}
                    row={row}
                    selected={selected.has(row.id)}
                    onSelect={toggle}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
