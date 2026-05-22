import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, DollarSign } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import type { ItemFullRow, SaleInsert } from "@/types/database";

interface SaleForm {
  sale_price: string;
  shipping_collected: string;
  platform_fees: string;
  payment_processing_fees: string;
  shipping_cost: string;
  tax: string;
  other_costs: string;
  buyer_username: string;
  sale_date: string;
}

function n(v: string): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

// Record a sale through the UI — fills the gap where sales previously only
// existed via CSV import. On save the item advances to "sold".
export function RecordSaleDialog({
  item,
  onClose,
}: {
  item: ItemFullRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<SaleForm>({
    sale_price: "",
    shipping_collected: "",
    platform_fees: "",
    payment_processing_fees: "",
    shipping_cost: "",
    tax: "",
    other_costs: "",
    buyer_username: "",
    sale_date: new Date().toISOString().slice(0, 10),
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setForm({
        sale_price: String(item.list_price ?? item.target_price ?? ""),
        shipping_collected: "",
        platform_fees: "",
        payment_processing_fees: "",
        shipping_cost: "",
        tax: "",
        other_costs: "",
        buyer_username: "",
        sale_date: new Date().toISOString().slice(0, 10),
      });
    }
  }, [item]);

  // Live net-profit preview.
  const net = useMemo(() => {
    if (!item) return 0;
    const cost = item.purchase_price ?? 0;
    return (
      n(form.sale_price) +
      n(form.shipping_collected) -
      n(form.platform_fees) -
      n(form.payment_processing_fees) -
      n(form.shipping_cost) -
      n(form.tax) -
      n(form.other_costs) -
      cost
    );
  }, [form, item]);

  if (!item) return null;

  function set<K extends keyof SaleForm>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!item) return;
    if (n(form.sale_price) <= 0) {
      toast.error("Enter the sale price.");
      return;
    }
    setSaving(true);
    try {
      const insert: SaleInsert = {
        inventory_item_id: item.id,
        listing_id: item.listing_id ?? null,
        sale_price: n(form.sale_price),
        shipping_collected: n(form.shipping_collected),
        platform_fees: n(form.platform_fees),
        payment_processing_fees: n(form.payment_processing_fees),
        shipping_cost: n(form.shipping_cost),
        tax: n(form.tax),
        other_costs: n(form.other_costs),
        net_profit: net,
        buyer_username: form.buyer_username.trim() || null,
        sale_date: form.sale_date || undefined,
        sold_at: form.sale_date || null,
      };
      const { error } = await supabase
        .from("sales")
        .insert(insert as never);
      if (error) throw error;

      const { error: sErr } = await supabase
        .from("inventory_items")
        .update({ status: "sold" } as never)
        .eq("id", item.id);
      if (sErr) throw sErr;

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["sale_for_item", item.id] });
      toast.success(`Sale recorded for "${item.item_title}".`);
      onClose();
    } catch (err) {
      toast.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record sale</DialogTitle>
          <DialogDescription>
            Log the sale of "{item.item_title}". The item moves to Sold.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Sale price"
            value={form.sale_price}
            onChange={(v) => set("sale_price", v)}
            autoFocus
          />
          <Field
            label="Shipping collected"
            value={form.shipping_collected}
            onChange={(v) => set("shipping_collected", v)}
          />
          <Field
            label="Marketplace fees"
            value={form.platform_fees}
            onChange={(v) => set("platform_fees", v)}
          />
          <Field
            label="Payment fees"
            value={form.payment_processing_fees}
            onChange={(v) => set("payment_processing_fees", v)}
          />
          <Field
            label="Shipping cost"
            value={form.shipping_cost}
            onChange={(v) => set("shipping_cost", v)}
          />
          <Field
            label="Tax"
            value={form.tax}
            onChange={(v) => set("tax", v)}
          />
          <Field
            label="Other costs"
            value={form.other_costs}
            onChange={(v) => set("other_costs", v)}
          />
          <div className="space-y-1">
            <Label className="text-xs">Sale date</Label>
            <Input
              type="date"
              value={form.sale_date}
              onChange={(e) => set("sale_date", e.target.value)}
            />
          </div>
          <div className="col-span-2 space-y-1">
            <Label className="text-xs">Buyer username</Label>
            <Input
              value={form.buyer_username}
              onChange={(e) => set("buyer_username", e.target.value)}
              placeholder="optional"
            />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            Net profit (cost basis ${(item.purchase_price ?? 0).toFixed(2)})
          </span>
          <span
            className={cn(
              "font-mono font-bold tabular-nums",
              net < 0
                ? "text-destructive"
                : "text-emerald-600 dark:text-emerald-400",
            )}
          >
            {net < 0 ? "-" : ""}${Math.abs(net).toFixed(2)}
          </span>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <DollarSign className="mr-2 h-4 w-4" />
            )}
            Record sale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        step="0.01"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
    </div>
  );
}
