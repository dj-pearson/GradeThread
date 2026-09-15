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
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { requestDrainNow } from "@/lib/lister-extension";
import { QUEUED_NOTICE } from "@/hooks/use-extension-queue";
import { todayLocalDate } from "@/lib/local-date";
import { computeNetProfit } from "@/lib/sale-math";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import { useItemListings, type ItemListingRow } from "@/hooks/use-item-listings";
import { ItemDelistPanel } from "@/components/flipdesk/delist-panel";
import { defaultSoldListing, SOLD_ELSEWHERE as ELSEWHERE } from "@/lib/delist-links";
import type { ItemFullRow, ListingPlatform } from "@/types/database";

function soldChoiceLabel(row: ItemListingRow): string {
  const name = MARKETPLACE_LABELS[row.platform as ListingPlatform] ?? row.platform;
  return row.listing_status === "active" ? name : `${name} (${row.listing_status ?? "draft"})`;
}

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
  // US-3369: every listing of this item, so the seller can say WHERE it sold.
  // The dialog used to close out `item.listing_id`, which is the item's primary
  // (usually eBay) listing, whatever marketplace the sale was actually on.
  const { data: listingRows = [] } = useItemListings(item?.id);
  const choices = listingRows.filter(
    (r) => r.listing_status === "active" || r.listing_status === "draft",
  );
  const [soldChoice, setSoldChoice] = useState<string>(ELSEWHERE);
  const choiceTouched = useRef(false);
  // After the save: the item's other listings still to end, shown in place of
  // the form so the seller can run the delist without going anywhere.
  const [delistStepFor, setDelistStepFor] = useState<string | null>(null);
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

  // Preselect once the listings arrive, unless the seller already chose.
  useEffect(() => {
    if (!choiceTouched.current) setSoldChoice(defaultSoldListing(listingRows));
  }, [listingRows]);

  // Live net-profit preview. The arithmetic lives in `@/lib/sale-math` because
  // that is the copy `sale-math.test.ts` pins against the edge's record-sale.ts
  // by source. Until 2026-09-13 this block spelled the expression out inline
  // instead, so there were THREE copies and the guard could only see two of
  // them -- the one the seller reads before pressing Save was the unpinned one.
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
      // US-3369: the listing that actually sold, or none when it sold somewhere
      // FlipDesk has no listing for.
      const soldListingId = soldChoice === ELSEWHERE ? null : soldChoice;

      // US-3367: one request. The server inserts the sale, advances the item,
      // closes the row it sold through (decrementing a multi-unit listing, per
      // US-1424 AC3), and hands every OTHER listing of the garment to the
      // sibling planner. It answers with which marketplaces the seller's
      // browser will end and which need the seller.
      //
      // This path was written from the browser between 40e95fadc and now: that
      // merge restored an older dialog that inserted `sales` directly, and the
      // compile fix on top of it kept the browser copy. A direct insert skips
      // the server's fee and provenance handling and ends nothing beyond the
      // one listing it knows about, which is the bug US-3367 was filed for.
      const res = await edgeFetch("/api/flipdesk/sales/record", {
        method: "POST",
        json: {
          inventory_item_id: item.id,
          listing_id: soldListingId,
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
      const queued = json.queued ?? [];
      const unresolved = json.unresolved ?? [];

      // US-3376: read back what is still live rather than trusting the plan.
      // This is the one check that catches an auto-end which reported success
      // and ended nothing, so "we don't know" has to mean "show the step", not
      // "hide it". null = unknown, and unknown counts as still listed.
      const { data: fresh, error: freshErr } = await supabase
        .from("listings")
        .select("id, listing_status")
        .eq("inventory_item_id", item.id);
      const liveLeft = freshErr
        ? null
        : ((fresh ?? []) as { id: string; listing_status: string }[]).filter(
            (r) =>
              r.id !== soldListingId &&
              (r.listing_status === "active" || r.listing_status === "draft"),
          ).length;
      if (freshErr) {
        toastWarning(freshErr, "We couldn't check what's still listed elsewhere.", {
          action: "check remaining listings",
          duration: 10_000,
          nextStep: "Use the delist step before you close this.",
        });
      }
      const showDelistStep =
        queued.length > 0 || unresolved.length > 0 || (liveLeft ?? 1) > 0;

      const label = (pf: string) => MARKETPLACE_LABELS[pf as ListingPlatform] ?? pf;
      if (queued.length > 0) {
        // Deliberately not "ended": those listings are live until the seller's
        // browser runs the job. QUEUED_NOTICE is the shared sentence for that.
        toast.info(
          `Ending it on ${queued.map(label).join(", ")} from your browser. ${QUEUED_NOTICE}`,
          { duration: 12_000 },
        );
        void requestDrainNow();
      }
      if (unresolved.length > 0) {
        toastWarning(undefined, `${unresolved.map(label).join(", ")} still needs you.`, {
          duration: 12_000,
        });
      }
      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["sale_for_item", item.id] });
      await qc.invalidateQueries({ queryKey: ["item_listings", item.id] });
      toast.success(`Sale recorded for "${item.item_title}".`);
      if (showDelistStep) {
        setDelistStepFor(item.id);
      } else {
        onClose();
      }
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
            {delistStepFor
              ? `Sale recorded. "${item.item_title}" is still listed below. End it there so it can't sell twice.`
              : `Log the sale of "${item.item_title}". The item moves to Sold.`}
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
          {/* US-3369: WHERE it sold. That listing is marked sold; every other
              listing of the item is ended. */}
          <div className="col-span-2 space-y-1">
            <Label className="text-xs" htmlFor="sold-on">Where did it sell?</Label>
            <Select
              value={soldChoice}
              onValueChange={(v) => {
                choiceTouched.current = true;
                setSoldChoice(v);
              }}
            >
              <SelectTrigger id="sold-on">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {soldChoiceLabel(row)}
                  </SelectItem>
                ))}
                <SelectItem value={ELSEWHERE}>Somewhere else</SelectItem>
              </SelectContent>
            </Select>
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
