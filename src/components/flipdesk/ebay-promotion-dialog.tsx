import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateItemPromotion,
  useEbayItemPromotion,
  useEbayPromotableListings,
  useUpdateItemPromotion,
  type ItemPromotionDraft,
  type ItemPromotionType,
} from "@/hooks/use-ebay";
import { cn } from "@/lib/utils";

// US-1979 (AC2): create/edit an eBay Promotions Manager item promotion.
//
// Until now a seller could not create an order/volume/coupon promo from FlipDesk at
// all — the card was read-only and told them to go to eBay Seller Hub.
//
// EDITING READS THE FULL PROMOTION FIRST. eBay's update is a PUT that REPLACES the
// promotion, and the list endpoint only returns id/name/type/status/dates. So this
// prefills from GET /promotions/:id (the whole thing) and never from the list row —
// otherwise saving a renamed promotion would silently wipe its targeting and
// discount, with no undo, while it kept its id and looked like it worked.

const TYPE_OPTIONS: Array<{ value: ItemPromotionType; label: string; blurb: string }> = [
  {
    value: "ORDER_DISCOUNT",
    label: "Order discount",
    blurb: "% off the whole order once the buyer spends a threshold.",
  },
  {
    value: "VOLUME_DISCOUNT",
    label: "Volume discount",
    blurb: "% off each item once the buyer takes N or more.",
  },
  {
    value: "CODED_COUPON",
    label: "Coupon code",
    blurb: "% off for buyers who enter a code you share.",
  },
];

// eBay requires a banner image for ORDER_DISCOUNT and CODED_COUPON, and refuses one
// for VOLUME_DISCOUNT. Kept in one place so the form and the payload agree.
function needsImage(type: ItemPromotionType): boolean {
  return type === "ORDER_DISCOUNT" || type === "CODED_COUPON";
}


export interface PromotionFormState {
  type: ItemPromotionType;
  name: string;
  selectedCount: number;
  percentOff: string;
  minSpend: string;
  buyQuantity: string;
  couponCode: string;
  imageUrl: string;
}

/**
 * The form's pre-check, mirroring the edge's validation (which runs eBay's real
 * body-builder). The EDGE remains the authority — this exists so the seller sees
 * the problem beside the field instead of via a round trip.
 *
 * Exported and pure so it can be tested against the same rules the edge enforces:
 * these two are the likeliest thing in the feature to drift, and the failure is
 * quiet — a form that permits what eBay rejects turns a fixable mistake into an
 * opaque "eBay rejected the promotion".
 */
export function promotionFormProblem(s: PromotionFormState): string | null {
  if (!s.name.trim()) return "Give the promotion a name.";
  if (s.selectedCount === 0) return "Pick at least one listing.";
  const pct = Number(s.percentOff);
  if (!Number.isFinite(pct) || pct <= 0) return "Enter a discount percentage.";
  if (s.type === "ORDER_DISCOUNT" && !/^\d+(\.\d{1,2})?$/.test(s.minSpend)) {
    return "Enter the minimum spend that unlocks the discount.";
  }
  if (s.type === "VOLUME_DISCOUNT" && Number(s.buyQuantity) < 2) {
    return "A volume discount needs a buy quantity of 2 or more.";
  }
  if (s.type === "CODED_COUPON" && !/^[A-Za-z0-9]{8,15}$/.test(s.couponCode)) {
    return "A coupon code is 8–15 letters and numbers.";
  }
  if (needsImage(s.type) && !s.imageUrl) {
    return "eBay needs a banner image for this promotion type — pick a listing with a photo, or paste an image URL.";
  }
  return null;
}

export interface EbayPromotionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing an existing promotion when set; creating when null. */
  promotionId: string | null;
}

export function EbayPromotionDialog({
  open,
  onOpenChange,
  promotionId,
}: EbayPromotionDialogProps) {
  const editing = !!promotionId;
  const { data: listings = [], isLoading: listingsLoading } =
    useEbayPromotableListings(open);
  const { data: existing, isLoading: existingLoading } = useEbayItemPromotion(
    open ? promotionId : null,
  );
  const create = useCreateItemPromotion();
  const update = useUpdateItemPromotion();

  const [type, setType] = useState<ItemPromotionType>("ORDER_DISCOUNT");
  const [name, setName] = useState("");
  const [percentOff, setPercentOff] = useState("15");
  const [selected, setSelected] = useState<string[]>([]);
  const [minSpend, setMinSpend] = useState("50.00");
  const [buyQuantity, setBuyQuantity] = useState("2");
  const [couponCode, setCouponCode] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageTouched, setImageTouched] = useState(false);

  // Prefill from the FULL promotion — see the note above on why not the list row.
  useEffect(() => {
    if (!open) return;
    if (!editing) {
      setType("ORDER_DISCOUNT");
      setName("");
      setPercentOff("15");
      setSelected([]);
      setMinSpend("50.00");
      setBuyQuantity("2");
      setCouponCode("");
      setImageUrl("");
      setImageTouched(false);
      return;
    }
    if (!existing) return;
    setType((existing.promotionType as ItemPromotionType) ?? "ORDER_DISCOUNT");
    setName(existing.name ?? "");
    setPercentOff(existing.percentOff != null ? String(existing.percentOff) : "15");
    setSelected(existing.listingIds ?? []);
    setMinSpend(existing.minSpend?.value ?? "50.00");
    setBuyQuantity(existing.buyQuantity != null ? String(existing.buyQuantity) : "2");
    setCouponCode(existing.couponCode ?? "");
    setImageUrl(existing.promotionImageUrl ?? "");
    setImageTouched(!!existing.promotionImageUrl);
  }, [open, editing, existing]);

  // The banner defaults to the first selected listing's cover photo — the same
  // source the automations path already uses — but it is SHOWN and overridable, so
  // the seller can see exactly what eBay will display rather than discovering it on
  // the live promo. Once they type their own, we stop overwriting it.
  const autoImage = useMemo(() => {
    const first = listings.find((l) => selected.includes(l.listingId));
    return first?.coverPhotoUrl ?? "";
  }, [listings, selected]);

  useEffect(() => {
    if (!imageTouched && autoImage) setImageUrl(autoImage);
  }, [autoImage, imageTouched]);

  const toggle = (listingId: string) => {
    setSelected((prev) =>
      prev.includes(listingId)
        ? prev.filter((id) => id !== listingId)
        : [...prev, listingId],
    );
  };

  const problem = useMemo(
    () =>
      promotionFormProblem({
        type,
        name,
        selectedCount: selected.length,
        percentOff,
        minSpend,
        buyQuantity,
        couponCode,
        imageUrl,
      }),
    [name, selected, percentOff, type, minSpend, buyQuantity, couponCode, imageUrl],
  );

  const buildDraft = (): ItemPromotionDraft => {
    const draft: ItemPromotionDraft = {
      type,
      name: name.trim(),
      listing_ids: selected,
      percent_off: Number(percentOff),
    };
    if (type === "ORDER_DISCOUNT") {
      draft.min_spend = { value: minSpend, currency: "USD" };
    }
    if (type === "VOLUME_DISCOUNT") draft.buy_quantity = Number(buyQuantity);
    if (type === "CODED_COUPON") draft.coupon_code = couponCode;
    if (needsImage(type)) draft.promotion_image_url = imageUrl;
    return draft;
  };

  const submit = async () => {
    if (problem) return;
    const draft = buildDraft();
    if (editing && promotionId) {
      await update.mutateAsync({ promotionId, draft });
    } else {
      await create.mutateAsync(draft);
    }
    onOpenChange(false);
  };

  const saving = create.isPending || update.isPending;
  const loading = editing && existingLoading;
  const active = TYPE_OPTIONS.find((t) => t.value === type);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit promotion" : "New eBay promotion"}</DialogTitle>
          <DialogDescription>
            Runs on eBay through Promotions Manager. Changes apply to your live
            listings.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="promo-type">Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as ItemPromotionType)}
                // eBay cannot change a promotion's type in place; a different type
                // is a different promotion. Locking it on edit is honest — the
                // alternative is a save that fails at eBay for a reason the form
                // implied was allowed.
                disabled={editing}
              >
                <SelectTrigger id="promo-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {active && (
                <p className="text-xs text-muted-foreground">{active.blurb}</p>
              )}
              {editing && (
                <p className="text-xs text-muted-foreground">
                  eBay can't change a promotion's type — end this one and create a
                  new one instead.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="promo-name">Name</Label>
              <Input
                id="promo-name"
                value={name}
                maxLength={90}
                onChange={(e) => setName(e.target.value)}
                placeholder="Spring clear-out"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="promo-pct">Discount %</Label>
              <Input
                id="promo-pct"
                type="number"
                min={5}
                max={70}
                value={percentOff}
                onChange={(e) => setPercentOff(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                eBay allows 5–70%.
              </p>
            </div>

            {type === "ORDER_DISCOUNT" && (
              <div className="space-y-2">
                <Label htmlFor="promo-min">Minimum spend (USD)</Label>
                <Input
                  id="promo-min"
                  inputMode="decimal"
                  value={minSpend}
                  onChange={(e) => setMinSpend(e.target.value)}
                  placeholder="50.00"
                />
              </div>
            )}

            {type === "VOLUME_DISCOUNT" && (
              <div className="space-y-2">
                <Label htmlFor="promo-qty">Buy quantity</Label>
                <Input
                  id="promo-qty"
                  type="number"
                  min={2}
                  value={buyQuantity}
                  onChange={(e) => setBuyQuantity(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The discount unlocks once a buyer takes this many.
                </p>
              </div>
            )}

            {type === "CODED_COUPON" && (
              <div className="space-y-2">
                <Label htmlFor="promo-code">Coupon code</Label>
                <Input
                  id="promo-code"
                  value={couponCode}
                  onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                  placeholder="SPRING2026"
                />
                <p className="text-xs text-muted-foreground">
                  8–15 letters and numbers. Must be unique across eBay.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>Listings ({selected.length} selected)</Label>
              {listingsLoading ? (
                <p className="text-sm text-muted-foreground">Loading your live listings…</p>
              ) : listings.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No live eBay listings to promote yet.
                </p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                  {listings.map((l) => (
                    <label
                      key={l.listingId}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted",
                      )}
                    >
                      <Checkbox
                        checked={selected.includes(l.listingId)}
                        onCheckedChange={() => toggle(l.listingId)}
                      />
                      <span className="truncate">{l.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {needsImage(type) && (
              <div className="space-y-2">
                <Label htmlFor="promo-img">Banner image</Label>
                <Input
                  id="promo-img"
                  value={imageUrl}
                  onChange={(e) => {
                    setImageTouched(true);
                    setImageUrl(e.target.value);
                  }}
                  placeholder="https://…"
                />
                <p className="text-xs text-muted-foreground">
                  {imageTouched
                    ? "eBay shows this on the promotion."
                    : "Defaults to your first selected listing's cover photo — paste a URL to use a different one."}
                </p>
              </div>
            )}

            {problem && (
              <p className="text-sm text-destructive" role="alert">
                {problem}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!!problem || saving || loading}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Create on eBay"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
