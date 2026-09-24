import { useEffect, useRef, useState } from "react";
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
import { InlineRetry } from "@/components/flipdesk/inline-retry";
import { toastError, toastWarning } from "@/lib/toast-error";
import { useShipQueue, type ShipQueueRow } from "@/hooks/use-ship-queue";
import {
  detectCarrier,
  SHIP_CARRIERS,
  shipButtonLabel,
  shipCountdown,
  shipOneOrder,
  stripUspsZipPrefix,
  type ShipCarrier,
  type ShipUrgency,
} from "@/pages/flipdesk/ship-queue";
import { markItemShipped, pushMarketplaceShip, shipSale } from "@/lib/ship-sale";
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
// pages/flipdesk/ship-queue.ts), by marketplace since PS-09. PS-08: the local
// write is lib/ship-sale.ts, shared with the ship-order dialog. It writes
// shipped_at, tracking_number and carrier on the sale, refuses loudly when no
// row changed, and moves the item to 'shipped'. Every other path also moves
// the item once its route has answered, so a garment shipped from here lands
// in the same state as one shipped from the dialog.

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
  onShipped,
}: {
  row: ShipQueueRow;
  selected: boolean;
  onSelect: (id: string, next: boolean) => void;
  /** Called after a successful ship, so the card can move focus on. */
  onShipped: (id: string) => void;
}) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState<ShipCarrier | "">("");
  // Once the seller picks a carrier, a later edit of the number stops
  // overwriting it with a guess.
  const [carrierPicked, setCarrierPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const ship = useEbayShipOrder();
  const qc = useQueryClient();
  const countdown = shipCountdown(row.shipBy);
  const name = row.title ?? row.orderRef ?? "this order";

  function onTrackingChange(value: string) {
    setTracking(value);
    if (!carrierPicked) setCarrier(detectCarrier(value) ?? "");
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    // PS-10: scanners and hand entry both add spaces, and a label barcode
    // carries the 420+ZIP routing prefix in front of the USPS number.
    const value = stripUspsZipPrefix(tracking);
    if (!value) {
      toast.error("Enter the tracking number first.");
      return;
    }
    const chosen = carrier || null;
    // `busy` rather than ship.isPending: the local path never touches that
    // mutation, so the button would stay live through the whole write.
    setBusy(true);
    try {
      let itemError: unknown = null;
      let refused: { path: "depop" | "shopify"; err: unknown } | null = null;
      const pushedThen = async (push: () => Promise<void>) => {
        await push();
        itemError = await markItemShipped(row.inventoryItemId);
      };
      const path = await shipOneOrder(
        row.orderRef,
        {
          pushToEbay: () =>
            pushedThen(async () => {
              await ship.mutateAsync({ saleId: row.id, trackingNumber: value, carrier: chosen });
            }),
          pushToDepop: () =>
            pushedThen(() => pushMarketplaceShip("depop", row.id, value, chosen)),
          pushToShopify: () =>
            pushedThen(() => pushMarketplaceShip("shopify", row.id, value, chosen)),
          writeLocal: async () => {
            const res = await shipSale({
              saleId: row.id,
              itemId: row.inventoryItemId,
              tracking: value,
              carrier: chosen,
            });
            itemError = res.itemError;
          },
          onPushRefused: (p, err) => {
            refused = { path: p, err };
          },
        },
        row.platform,
      );
      // The row leaves this queue because shipped_at is now set; the needs-you
      // merge reads the same query, so both surfaces update from one refetch.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["ship_queue"] }),
        qc.invalidateQueries({ queryKey: ["inventory"] }),
        qc.invalidateQueries({ queryKey: ["items_full"] }),
      ]);
      const refusal = refused as { path: "depop" | "shopify"; err: unknown } | null;
      if (refusal) {
        // Recorded here, not on the marketplace. The buyer has no tracking yet.
        const market = refusal.path === "depop" ? "Depop" : "Shopify";
        toastWarning(refusal.err, `Marked shipped here, but ${market} did not get the tracking.`, {
          action: `send tracking to ${market}`,
          nextStep: `Add the tracking in ${market} so the buyer can follow the parcel.`,
        });
      }
      if (itemError) {
        // The shipment happened. Say which half did not land.
        toastWarning(itemError, "Marked shipped, but the item is not in the Shipped tab yet.", {
          action: "mark item shipped",
          nextStep: "Open the item and set it to Shipped.",
        });
      }
      if (!refusal && !itemError) {
        toast.success(
          path === "ebay"
            ? "Marked shipped, and the tracking is on eBay."
            : path === "depop"
              ? "Marked shipped, and the tracking is on Depop."
              : path === "shopify"
                ? "Marked shipped, and the tracking is on Shopify."
                : "Marked shipped.",
        );
      }
      onShipped(row.id);
    } catch (err) {
      toastError(err, "Could not mark it shipped.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <TableRow data-focus-id={row.id} className="data-[focused=true]:ring-2 data-[focused=true]:ring-primary focus-visible:outline-none">
      <TableCell className="w-8 align-top">
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onSelect(row.id, v === true)}
          aria-label={`Select ${name} for a packing slip`}
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
        {/* PS-10: a form, so Enter submits. A barcode scanner types the
            number and presses Enter, and until now that did nothing. */}
        <form className="flex items-center gap-1.5" onSubmit={submit}>
          <Input
            aria-label={`Tracking number for ${name}`}
            data-ship-tracking={row.id}
            value={tracking}
            onChange={(e) => onTrackingChange(e.target.value)}
            placeholder="Tracking number"
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="characters"
            enterKeyHint="send"
            className="h-8 min-w-[11rem] text-xs"
          />
          <select
            aria-label={`Carrier for ${name}`}
            value={carrier}
            onChange={(e) => {
              setCarrier(e.target.value as ShipCarrier | "");
              setCarrierPicked(true);
            }}
            className="h-8 w-24 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">Carrier</option>
            {SHIP_CARRIERS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Button
            type="submit"
            size="sm"
            disabled={busy}
            className="h-8 gap-1 whitespace-nowrap"
          >
            <Truck aria-hidden="true" className="h-3.5 w-3.5" />
            {/* PS-09: the label says what the button does for THIS order. */}
            {busy ? "Saving\u2026" : shipButtonLabel(row.platform, row.orderRef)}
          </Button>
        </form>
      </TableCell>
    </TableRow>
  );
}

export function ShipQueueCard() {
  const { rows, data, isLoading, isError, isFetching, refetch } = useShipQueue();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // PS-10: after a row ships, the next row's tracking box takes focus, so a
  // scanner session is scan, scan, scan with no mouse in between.
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const overdue = rows.filter(
    (r) => shipCountdown(r.shipBy).urgency === "overdue",
  ).length;
  // Only rows still in the queue count. A shipped row leaves `rows` on the
  // refetch, and a tick left behind on it must not print a slip.
  const liveSelected = rows.filter((r) => selected.has(r.id));
  const allSelected = rows.length > 0 && liveSelected.length === rows.length;
  const someSelected = liveSelected.length > 0 && !allSelected;
  const hasData = data !== undefined;

  useEffect(() => {
    if (!focusNext) return;
    const el = [
      ...(cardRef.current?.querySelectorAll<HTMLInputElement>("[data-ship-tracking]") ?? []),
    ].find((input) => input.dataset.shipTracking === focusNext);
    if (el) {
      el.focus();
      setFocusNext(null);
    }
  }, [focusNext, rows]);

  function onShipped(id: string) {
    const i = rows.findIndex((r) => r.id === id);
    const next = i >= 0 ? rows[i + 1] ?? null : null;
    setFocusNext(next?.id ?? null);
  }

  function toggle(id: string, next: boolean) {
    setSelected((prev) => {
      const out = new Set(prev);
      if (next) out.add(id);
      else out.delete(id);
      return out;
    });
  }

  function toggleAll(next: boolean) {
    setSelected(next ? new Set(rows.map((r) => r.id)) : new Set());
  }

  function printSlips() {
    const chosen = liveSelected;
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
    <Card id="ship-queue" className="scroll-mt-20" ref={cardRef}>
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
              {liveSelected.length > 0 ? ` (${liveSelected.length})` : ""}
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
        ) : isError && !hasData ? (
          <InlineRetry
            message="Couldn't load the ship queue."
            onRetry={() => void refetch()}
          />
        ) : rows.length === 0 ? (
          isError ? (
            <InlineRetry
              message="Couldn't refresh the ship queue."
              onRetry={() => void refetch()}
            />
          ) : (
            <EmptyState
              icon={Package}
              title="Nothing waiting to ship"
              description="Every completed sale has a tracking number on it."
            />
          )
        ) : (
          /* A table, because this is a list a seller SCANS. The card stack
             made every row a paragraph, so comparing two deadlines or spotting
             which order is in the wrong tote meant reading prose; a grid puts
             the same facts in columns that line up.

             Its own horizontal scroller: six columns and two inputs do not fit
             a phone, and the page body must never scroll sideways. */
          <>
            {/* PS-10: a failed background refresh keeps the rows. They were
                real a minute ago, and hiding them would hide the work. */}
            {isError && !isFetching ? (
              <div className="mb-3">
                <InlineRetry
                  message="Couldn't refresh the ship queue. These rows may be out of date."
                  onRetry={() => void refetch()}
                />
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox
                        checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        onCheckedChange={(v) => toggleAll(v === true)}
                        aria-label="Select all orders"
                      />
                    </TableHead>
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
                      onShipped={onShipped}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
