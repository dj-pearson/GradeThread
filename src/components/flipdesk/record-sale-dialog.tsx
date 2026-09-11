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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldError } from "@/components/ui/form-feedback";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { edgeFetch } from "@/lib/edge-fetch";
import { computeNetProfit } from "@/lib/sale-math";
import { todayLocalDate } from "@/lib/local-date";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import { requestDrainNow } from "@/lib/lister-extension";
import { QUEUED_NOTICE } from "@/hooks/use-extension-queue";
import { useItemListings } from "@/hooks/use-item-listings";
import type { ItemFullRow, ListingPlatform } from "@/types/database";

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
//
// US-3367: the writes moved to POST /api/flipdesk/sales/record. This dialog
// used to insert the sale and end the eBay listing from the browser and never
// told the sibling planner, so a sale on Poshmark left Mercari, Grailed and
// Vinted live. Now it asks WHERE it sold and the server ends everything else.
export function RecordSaleDialog({
  item,
  onClose,
}: {
  item: ItemFullRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: listingRows = [] } = useItemListings(item?.id);
  /** The listings row it sold through; "" means somewhere FlipDesk has no row for. */
  const [soldOn, setSoldOn] = useState<string>("");
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
      choiceTouched.current = false;
      setDelistStepFor(null);
    }
  }, [item]);

  // Default "Sold on": the one live listing when there is exactly one, else
  // eBay when the item has an eBay row, else "somewhere else".
  useEffect(() => {
    if (!item) return;
    const active = listingRows.filter((r) => r.listing_status === "active");
    const ebay = listingRows.find((r) => r.platform === "ebay");
    const only = active.length === 1 ? active[0] : undefined;
    setSoldOn(only?.id ?? ebay?.id ?? "");
  }, [item, listingRows]);

  // Live net-profit preview: the same formula the server writes.
  const net = useMemo(() => {
    if (!item) return 0;
    return computeNetProfit(
      {
        sale_price: n(form.sale_price),
        shipping_collected: n(form.shipping_collected),
        platform_fees: n(form.platform_fees),
        payment_processing_fees: n(form.payment_processing_fees),
        shipping_cost: n(form.shipping_cost),
        tax: n(form.tax),
        other_costs: n(form.other_costs),
      },
      item.purchase_price ?? 0,
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
      // US-3367: one request. The server inserts the sale, advances the item,
      // closes the row it sold through (decrementing a multi-unit listing, per
      // US-1424 AC3), ends an API-channel row upstream, and hands every OTHER
      // listing of the garment to the sibling planner. It answers with which
      // marketplaces the seller's browser will end and which need the seller.
      const res = await edgeFetch("/api/flipdesk/sales/record", {
        method: "POST",
        json: {
          inventory_item_id: item.id,
          listing_id: soldOn || null,
          sale_price: n(form.sale_price),
          shipping_collected: n(form.shipping_collected),
          platform_fees: n(form.platform_fees),
          payment_processing_fees: n(form.payment_processing_fees),
          shipping_cost: n(form.shipping_cost),
          tax: n(form.tax),
          other_costs: n(form.other_costs),
          buyer_username: form.buyer_username.trim() || null,
          sale_date: form.sale_date || null,
        },
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        queued?: string[];
        unresolved?: string[];
      };
      if (!res.ok) throw new Error(json.error ?? "Failed.");

      // US-3369: the garment is gone, so end it everywhere else. Same engine,
      // same auto-end switch, as a sale that arrives by webhook. Units left on
      // a multi-quantity listing mean it is still for sale, so nothing ends.
      let showDelistStep = false;
      if (lastUnitSold) {
        try {
          const res = await endOthers.mutateAsync({
            itemId: item.id,
            soldListingId,
            mode: "auto",
          });
          const { data: fresh, error: freshErr } = await supabase
            .from("listings")
            .select("id, listing_status")
            .eq("inventory_item_id", item.id);
          // US-3376: this READ used to drop its error, which made `liveLeft`
          // zero and could SKIP the delist step entirely. That step is the one
          // thing that catches an auto-end which reported success and did not
          // end anything, so "we don't know" has to mean "show it", not "hide
          // it". null = unknown, and unknown counts as "something is still up".
          const liveLeft = freshErr
            ? null
            : ((fresh ?? []) as { id: string; listing_status: string }[]).filter(
                (r) =>
                  r.id !== soldListingId &&
                  (r.listing_status === "active" ||
                    r.listing_status === "draft"),
              ).length;
          if (freshErr) {
            toastWarning(
              freshErr,
              "We couldn't check what's still listed elsewhere.",
              {
                action: "check remaining listings",
                duration: 10_000,
                nextStep: "Use the delist step before you close this.",
              },
            );
          }
          showDelistStep =
            res.pending.length > 0 ||
            res.summary.unresolved > 0 ||
            (liveLeft ?? 1) > 0;
          const ended = res.summary.ended;
          if (ended > 0) {
            toast.success(`Ended ${ended} other listing${ended === 1 ? "" : "s"} automatically.`);
          }
        } catch (err) {
          // The sale is recorded; the panel on the item page can still run it.
          toastWarning(err, "Sale recorded, but we could not end the other listings.", {
            duration: 10_000,
            nextStep: "Open the item and press Delist from other platforms.",
          });
        }
      }

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["sale_for_item", item.id] });
      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
      void qc.invalidateQueries({ queryKey: ["item_listings", item.id] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });

      const label = (p: string) => MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
      const queued = (json.queued ?? []).map(label);
      const unresolved = (json.unresolved ?? []).map(label);
      toast.success(`Sale recorded for "${item.item_title}".`);
      if (queued.length > 0) {
        // Deliberately not "ended": those listings are live until the seller's
        // browser runs the job. QUEUED_NOTICE is the shared sentence for that.
        toast.info(
          `Ending it on ${queued.join(", ")} from your browser. ${QUEUED_NOTICE}`,
          { duration: 12_000 },
        );
        void requestDrainNow();
      }
      if (unresolved.length > 0) {
        toastWarning(
          undefined,
          `${unresolved.join(", ")} still needs you.`,
          {
            duration: 12_000,
            nextStep: "End it there yourself so the same item cannot sell twice.",
          },
        );
      }
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
            Log the sale of "{item.item_title}". The item moves to Sold and its
            other listings are ended.
          </DialogDescription>
        </DialogHeader>

        {delistStepFor ? (
          <>
            {/* US-3369: the delist, right where the sale was recorded. */}
            <ItemDelistPanel itemId={delistStepFor} itemStatus="sold" />
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
        <div className="grid grid-cols-2 gap-3">
          {/* US-3367: WHERE it sold decides which row closes and which siblings
              the server ends. "Somewhere else" ends every live listing. */}
          <div className="col-span-2 space-y-1">
            <Label className="text-xs" htmlFor="sold-on">Sold on</Label>
            <Select
              value={soldOn || "none"}
              onValueChange={(v) => setSoldOn(v === "none" ? "" : v)}
            >
              <SelectTrigger id="sold-on" className="w-full">
                <SelectValue placeholder="Where did it sell?" />
              </SelectTrigger>
              <SelectContent>
                {listingRows.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {MARKETPLACE_LABELS[r.platform as ListingPlatform] ?? r.platform}
                    {r.listing_status === "active" ? "" : ` (${r.listing_status ?? "draft"})`}
                  </SelectItem>
                ))}
                <SelectItem value="none">Somewhere else / in person</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Every other listing of this item is ended for you. Marketplaces
              without an API are ended from your own browser.
            </p>
          </div>
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
          </>
        )}
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
