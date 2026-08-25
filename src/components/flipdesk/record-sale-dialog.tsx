import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError, toastWarning } from "@/lib/toast-error";
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
import { FieldError } from "@/components/ui/form-feedback";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { advanceItemStatus } from "@/lib/status-writer";
import { todayLocalDate } from "@/lib/local-date";
import { useEbayConnection, useEbayEndListing } from "@/hooks/use-ebay";
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
  const { data: ebayConnection } = useEbayConnection();
  const endListingApi = useEbayEndListing();
  const [form, setForm] = useState<SaleForm>({
    sale_price: "",
    shipping_collected: "",
    platform_fees: "",
    payment_processing_fees: "",
    shipping_cost: "",
    tax: "",
    other_costs: "",
    buyer_username: "",
    sale_date: todayLocalDate(),
  });
  const [saving, setSaving] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  // Synchronous double-submit guard: `disabled={saving}` only applies next
  // render, so a fast double-click could insert two `sales` rows (and double
  // advanceItemStatus), corrupting reconciliation. Flip this before any await.
  const savingRef = useRef(false);

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
        sale_date: todayLocalDate(),
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
    if (savingRef.current) return;
    if (n(form.sale_price) <= 0) {
      setPriceError("Enter a sale price greater than 0.");
      document.getElementById("sale-price")?.focus();
      return;
    }
    // Reject negative fees/costs — the min="0" input hint is advisory, and a
    // negative here silently inflates net profit and corrupts reconciliation.
    const costFields = [
      form.shipping_collected,
      form.platform_fees,
      form.payment_processing_fees,
      form.shipping_cost,
      form.tax,
      form.other_costs,
    ];
    if (costFields.some((v) => n(v) < 0)) {
      toast.error("Fees and costs can't be negative.");
      return;
    }
    setPriceError(null);
    savingRef.current = true;
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

      await advanceItemStatus(item.id, item.status, "sold");

      // US-1424: a manual sale must also close out the listing, or the item
      // stays is_active=true / 'active' on eBay after being marked sold
      // (overselling risk + a stale 'active' chip). This is best-effort — the
      // sale is already recorded, so a listing-close hiccup warns rather than
      // failing the whole action.
      if (item.listing_id) {
        try {
          const { data: lst, error: lErr } = await supabase
            .from("listings")
            .select("id, quantity, platform_offer_id, platform_listing_id")
            .eq("id", item.listing_id)
            .maybeSingle();
          if (lErr) throw lErr;
          const listing = lst as {
            id: string;
            quantity: number | null;
            platform_offer_id: string | null;
            platform_listing_id: string | null;
          } | null;
          if (listing) {
            // AC3: a multi-quantity listing only ends when the last unit sells —
            // otherwise decrement the remaining quantity and keep it active.
            const remaining = Math.max(0, (listing.quantity ?? 1) - 1);
            if (remaining > 0) {
              const { error } = await supabase
                .from("listings")
                .update({ quantity: remaining } as never)
                .eq("id", listing.id);
              if (error) throw error;
            } else {
              // AC1: end the listing locally (sold + inactive).
              const { error } = await supabase
                .from("listings")
                .update({
                  listing_status: "sold",
                  is_active: false,
                  quantity: 0,
                } as never)
                .eq("id", listing.id);
              if (error) throw error;
              // AC2: best-effort end on eBay when connected and the listing
              // carries an eBay offer/listing id. A failure must NOT fail the
              // recorded sale — surface it so the user can end it manually.
              if (
                ebayConnection &&
                (listing.platform_offer_id || listing.platform_listing_id)
              ) {
                try {
                  await endListingApi.mutateAsync({ listingId: listing.id });
                } catch (err) {
                  const e = err as Error & { status?: number };
                  // 409 = no platform_offer_id server-side → nothing to end.
                  if (e.status !== 409) {
                    toastWarning(e, "Sale recorded, but we could not end the eBay listing.", {
                      duration: 10_000,
                      nextStep: "End it on eBay yourself so it cannot sell twice.",
                    });
                  }
                }
              }
            }
          }
        } catch (err) {
          toastWarning(
            err,
            "Sale recorded, but we could not update the listing.",
            { duration: 10_000 },
          );
        }
      }

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["sale_for_item", item.id] });
      toast.success(`Sale recorded for "${item.item_title}".`);
      onClose();
    } catch (err) {
      toastError(err, "Failed.");
    } finally {
      savingRef.current = false;
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
            id="sale-price"
            label="Sale price"
            value={form.sale_price}
            onChange={(v) => {
              set("sale_price", v);
              if (priceError) setPriceError(null);
            }}
            error={priceError}
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
            <Label className="text-xs" htmlFor="sale-date">Sale date</Label>
            <Input
              id="sale-date"
              type="date"
              value={form.sale_date}
              onChange={(e) => set("sale_date", e.target.value)}
            />
          </div>
          <div className="col-span-2 space-y-1">
            <Label className="text-xs" htmlFor="buyer-username">Buyer username</Label>
            <Input
              id="buyer-username"
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
  id,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  id?: string;
  error?: string | null;
}) {
  // Always associate the label with the input. Most callers don't pass an id,
  // which previously rendered <Label htmlFor={undefined}> / <Input id={undefined}>
  // — no programmatic association, so screen readers announced unlabeled number
  // fields on a money form. Derive a stable id from the label as the fallback.
  const fieldId = id ?? `sale-field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="space-y-1">
      <Label className="text-xs" htmlFor={fieldId}>
        {label}
      </Label>
      <Input
        id={fieldId}
        type="number"
        step="0.01"
        min="0"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        aria-invalid={!!error}
        aria-describedby={error ? `${fieldId}-error` : undefined}
      />
      {error && <FieldError id={`${fieldId}-error`}>{error}</FieldError>}
    </div>
  );
}
