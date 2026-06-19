import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Truck } from "lucide-react";
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
import { useEbayShipOrder } from "@/hooks/use-ebay";
import type { ItemFullRow } from "@/types/database";

// US-1039: mark a sold order shipped and push the tracking number + carrier to
// eBay (Sell Fulfillment API) so the buyer sees tracking and the order shows
// Shipped. For an eBay order this calls the ship route (which also records
// shipped_at + tracking server-side); for a manual/other-marketplace sale (the
// route returns 409) it records shipping locally. Either way the item moves to
// the Shipped tab.
const CARRIERS = ["USPS", "UPS", "FedEx", "DHL", "Other"] as const;

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

  useEffect(() => {
    if (item) {
      setTracking("");
      setCarrier("USPS");
    }
  }, [item]);

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
      toast.error(
        e.status === 502
          ? `eBay rejected the tracking: ${e.message}`
          : `Couldn't mark shipped: ${
              e instanceof Error ? e.message : String(e)
            }`,
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
