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

// US-960 / US-1425: bulk "Prepare shipment" — pick one carrier for the whole
// batch, enter a per-item tracking number, then advance every selected sold item
// to shipped in one pass.
//
// US-1425: for an eBay order (its most-recent sale has a platform_order_id) with
// a tracking number, this now pushes tracking to eBay via the ship route (the
// same path as the single-item ShipOrderDialog) — the route records shipped_at +
// tracking server-side — instead of a local-only write that left the buyer with
// no tracking and eBay considering the order unshipped (late-shipment/INR risk).
// Manual/other-marketplace sales (and eBay orders still lacking a tracking
// number) are recorded locally. A per-item eBay rejection is surfaced for that
// row and does NOT fail the rest of the batch.
const CARRIERS = ["USPS", "UPS", "FedEx", "DHL", "Other"] as const;

interface PrepareShipmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ItemFullRow[];
  /** Called after the batch is applied so the caller can clear its selection. */
  onApplied: () => void;
}

export function PrepareShipmentDialog({
  open,
  onOpenChange,
  items,
  onApplied,
}: PrepareShipmentDialogProps) {
  const qc = useQueryClient();
  const ship = useEbayShipOrder();
  const [carrier, setCarrier] = useState<string>("USPS");
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Reset the per-item tracking inputs each time the dialog opens, seeding any
  // tracking already recorded on the item.
  const key = items.map((i) => i.id).join(",");
  useEffect(() => {
    if (!open) return;
    setCarrier("USPS");
    setTracking(
      Object.fromEntries(items.map((i) => [i.id, i.tracking ?? ""])),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  async function submit() {
    if (items.length === 0) return;
    setBusy(true);
    const now = new Date().toISOString();
    const errors: string[] = [];
    // US-1425 (AC2): report per-item pushed-to-eBay vs recorded-locally.
    let pushed = 0;
    let local = 0;
    for (const it of items) {
      const tn = (tracking[it.id] ?? "").trim();
      const label = it.item_title || it.item_number || it.id;
      try {
        // Find the item's most-recent sale — its platform_order_id tells us
        // whether this is an eBay order we can push tracking to.
        const { data: saleRow, error: saleErr } = await supabase
          .from("sales")
          .select("id, platform_order_id")
          .eq("inventory_item_id", it.id)
          .order("sale_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (saleErr) throw saleErr;
        const sale = saleRow as
          | { id: string; platform_order_id: string | null }
          | null;

        if (sale?.platform_order_id && tn) {
          // eBay order with a tracking number → push to eBay via the ship route
          // (records shipped_at + tracking server-side). A rejection throws and
          // is surfaced for this row below; the item is left un-shipped so it can
          // be retried, rather than desyncing (marked shipped locally but not on
          // eBay).
          const res = await ship.mutateAsync({
            saleId: sale.id,
            trackingNumber: tn,
            carrier,
          });
          if (res.pushed_to_ebay) pushed++;
          else local++;
        } else if (sale) {
          // Manual/other-marketplace sale, or an eBay order without a tracking
          // number yet → record shipping locally (the user can push tracking
          // later from the single-item dialog).
          const { error: upErr } = await supabase
            .from("sales")
            .update({
              carrier,
              tracking_number: tn || null,
              shipped_at: now,
            } as never)
            .eq("id", sale.id);
          if (upErr) throw upErr;
          local++;
        } else {
          // No sale row — nothing to stamp, just advance the item's status.
          local++;
        }

        const { error: iErr } = await supabase
          .from("inventory_items")
          .update({ status: "shipped" } as never)
          .eq("id", it.id);
        if (iErr) throw iErr;
      } catch (err) {
        const e = err as Error & { status?: number };
        errors.push(
          e?.status === 502
            ? `${label}: eBay rejected the tracking — ${e.message}`
            : `${label}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    setBusy(false);
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    const done = pushed + local;
    // Human-readable breakdown of where each shipment landed (AC2).
    const parts: string[] = [];
    if (pushed > 0) parts.push(`${pushed} pushed to eBay`);
    if (local > 0) parts.push(`${local} recorded locally`);
    const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    if (errors.length === 0) {
      toast.success(
        `Prepared ${done} shipment${done === 1 ? "" : "s"} via ${carrier}${breakdown}.`,
      );
      onApplied();
      onOpenChange(false);
    } else {
      toast.warning(
        `Shipped ${done}${breakdown}; ${errors.length} failed. First: ${errors[0]}`,
        { duration: 12_000 },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Prepare shipment</DialogTitle>
          <DialogDescription>
            Set the carrier for all {items.length} selected item
            {items.length === 1 ? "" : "s"}, add each tracking number, then mark
            them shipped. Tracking is optional — leave it blank to add later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="prep-carrier">Carrier</Label>
            <select
              id="prep-carrier"
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
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {items.map((it) => (
              <div key={it.id} className="space-y-1">
                <Label
                  htmlFor={`prep-tracking-${it.id}`}
                  className="truncate text-xs text-muted-foreground"
                >
                  {it.item_title}
                  {it.item_number ? ` · ${it.item_number}` : ""}
                </Label>
                <Input
                  id={`prep-tracking-${it.id}`}
                  value={tracking[it.id] ?? ""}
                  onChange={(e) =>
                    setTracking((prev) => ({
                      ...prev,
                      [it.id]: e.target.value,
                    }))
                  }
                  placeholder="Tracking number"
                  className="h-8 text-sm"
                />
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Truck className="mr-2 h-4 w-4" />
            )}
            Mark {items.length} shipped
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
