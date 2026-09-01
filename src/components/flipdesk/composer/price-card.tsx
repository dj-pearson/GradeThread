import { AiDiffChip } from "@/components/flipdesk/ai-diff-chip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { dollarInputToCents, lowAcceptWarning } from "@/lib/best-offer-thresholds";

import { aiPriceInput, conditionLabel, formatAiPrice, priceChanged, textChanged } from "@/lib/listing-ai-diff";
import { cn } from "@/lib/utils";
import { CONDITION_DESC_MAX } from "@/lib/composer-save";
import type { ListingAiSnapshot } from "@/types/database";
import type { ListingFormatValue } from "@/components/flipdesk/listing-format-controls";
import type { useEbayCategoryConditions } from "@/hooks/use-ebay";
import type { FieldSaveState } from "@/lib/composer-autosave";

type CategoryConditions = NonNullable<
  ReturnType<typeof useEbayCategoryConditions>["data"]
>;
export interface PriceCardProps {
  ebayCondition: string;
  setEbayCondition: (next: string) => void;
  /** Driven by the LEAF's allowed conditions — many apparel categories reject the legacy USED_* tiers. */
  conditionOptions: { value: string; label: string }[];
  conditionRejected: boolean;
  categoryConditions: CategoryConditions | null | undefined;
  conditionDesc: string;
  setConditionDesc: (next: string) => void;
  price: string;
  setPrice: (next: string) => void;
  priceEstimated: boolean;
  setPriceEstimated: (next: boolean) => void;
  priceCompSource: string | null;
  setPriceCompSource: (next: string | null) => void;
  /** US-9205: the one line under a prefilled price: grade, comps used, days to sell. */
  priceWhy?: string | null;
  /** US-9205: the graded price on offer once a grade lands on a comp-median draft. */
  gradedOffer?: { cents: number; why: string } | null;
  onUseGradedPrice?: () => void;
  quantity: string;
  setQuantity: (next: string) => void;
  quantityInvalid: boolean;
  /** Non-null when a variation matrix owns the total, so the input is replaced by the derived number. */
  variationQuantity: number | null;
  listingFormat: ListingFormatValue;
  bestOfferEnabled: boolean;
  setBestOfferEnabled: (on: boolean) => void;
  bestOfferAccept: string;
  setBestOfferAccept: (next: string) => void;
  bestOfferDecline: string;
  setBestOfferDecline: (next: string) => void;
  aiSnapshot: ListingAiSnapshot | null;
  isEbayOrigin: boolean;
  ebayOwnedHint: string | undefined;
  /** US-2634: the price writes itself; this is what that write is doing. */
  priceSaveState: FieldSaveState;
  /**
   * US-2641: true when this listing is already on the marketplace, so the write
   * is a REPRICE of something buyers can see rather than a draft edit. The two
   * cases fail differently and a seller has to be told which one they are in:
   * a draft that did not save costs a retype, a live price that did not push
   * leaves eBay charging the old number while every screen here shows the new
   * one.
   */
  priceIsLive: boolean;
}

const PRICE_SAVE_TEXT: Record<FieldSaveState, string> = {
  idle: "",
  saving: "Saving price...",
  saved: "Price saved",
  error: "Price not saved yet — use Save draft",
};

const LIVE_PRICE_SAVE_TEXT: Record<FieldSaveState, string> = {
  idle: "",
  saving: "Sending the new price to the marketplace...",
  saved: "Price updated on the marketplace",
  error:
    "The marketplace did not take the new price, so it was not saved — the old price is still live. Try Save & resubmit.",
};
// Condition, price, quantity and Best Offer — the levers that decide what a
// buyer pays. Cost basis and its read-outs deliberately live in their own card
// (US-2254): they are inventory bookkeeping and analysis, not listing inputs.
export function PriceCard({
  ebayCondition,
  setEbayCondition,
  conditionOptions,
  conditionRejected,
  categoryConditions,
  conditionDesc,
  setConditionDesc,
  price,
  setPrice,
  priceEstimated,
  setPriceEstimated,
  priceCompSource,
  setPriceCompSource,
  priceWhy = null,
  gradedOffer = null,
  onUseGradedPrice,
  quantity,
  setQuantity,
  quantityInvalid,
  variationQuantity,
  listingFormat,
  bestOfferEnabled,
  setBestOfferEnabled,
  bestOfferAccept,
  setBestOfferAccept,
  bestOfferDecline,
  setBestOfferDecline,
  aiSnapshot,
  isEbayOrigin,
  ebayOwnedHint,
  priceSaveState,
  priceIsLive,
}: PriceCardProps) {
  // US-2405: warn (never block) when auto-accept sits far under the asking
  // price — the shape a threshold takes once the price has moved past it.
  const lowAccept = bestOfferEnabled
    ? lowAcceptWarning(
        dollarInputToCents(price) ?? 0,
        dollarInputToCents(bestOfferAccept),
      )
    : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Condition &amp; price</CardTitle>
        <CardDescription>
          The eBay condition and starting price for this listing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="ebay-condition">eBay condition</Label>
          {/* US-2262: a shadcn Select like every other dropdown on the page.
              This was the one raw <select> left, on the field most likely to
              get a listing bounced. The id stays `ebay-condition` so the
              AutoLister pre-flight deep link (COMPOSER_FOCUS_ANCHORS.condition)
              still lands on it. */}
          <Select
            value={ebayCondition || "__none"}
            onValueChange={(v) =>
              setEbayCondition(v === "__none" ? "" : v)
            }
          >
            <SelectTrigger id="ebay-condition">
              <SelectValue placeholder="Select condition…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Select condition…</SelectItem>
              {conditionOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {conditionRejected && (
            <p className="text-xs text-destructive">
              This condition isn't accepted by the selected eBay category —
              pick one of the allowed conditions above, or eBay will reject
              the listing at publish.
            </p>
          )}
          {categoryConditions?.restricted &&
            categoryConditions.allowedLabels.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                This category accepts: {categoryConditions.allowedLabels.join(", ")}.
              </p>
            )}
          {aiSnapshot && (
            <AiDiffChip
              changed={textChanged(aiSnapshot.ebay_condition, ebayCondition)}
              aiDisplay={conditionLabel(aiSnapshot.ebay_condition)}
              onRevert={() => setEbayCondition(aiSnapshot.ebay_condition ?? "")}
            />
          )}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="condition-desc">Condition description</Label>
            {/* US-2257: eBay caps this at 1000 characters. A hard cap plus
                a counter beats losing the tail of a long flaw list to a
                server-side truncation nobody sees. */}
            <span
              className={cn(
                "text-[10px] tabular-nums",
                conditionDesc.length >= CONDITION_DESC_MAX
                  ? "font-semibold text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {conditionDesc.length}/{CONDITION_DESC_MAX}
            </span>
          </div>
          <Textarea
            id="condition-desc"
            value={conditionDesc}
            maxLength={CONDITION_DESC_MAX}
            onChange={(e) => setConditionDesc(e.target.value)}
            rows={3}
            placeholder="Honest, buyer-facing condition notes — call out any flaws."
          />
          {aiSnapshot && (
            <AiDiffChip
              changed={textChanged(
                aiSnapshot.condition_description,
                conditionDesc,
              )}
              aiDisplay={aiSnapshot.condition_description ?? ""}
              onRevert={() =>
                setConditionDesc(aiSnapshot.condition_description ?? "")
              }
            />
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="listing-price">Price (USD)</Label>
          <div className="flex items-center gap-2">
            <Input
              id="listing-price"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                setPriceEstimated(false);
                setPriceCompSource(null);
              }}
              placeholder="0.00"
              className="max-w-[10rem]"
              disabled={isEbayOrigin}
              title={
                isEbayOrigin
                  ? "eBay owns this listing's price — change it on eBay."
                  : undefined
              }
            />
            {priceEstimated && (
              <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
                {priceCompSource === "active_asking"
                  ? "Asking-price comp — may run high"
                  : "AI estimate — verify"}
              </Badge>
            )}
            {aiSnapshot && (
              <AiDiffChip
                changed={priceChanged(aiSnapshot.price_cents, price)}
                aiDisplay={formatAiPrice(aiSnapshot.price_cents)}
                onRevert={() => {
                  setPrice(aiPriceInput(aiSnapshot.price_cents));
                  setPriceEstimated(true);
                  setPriceCompSource(null);
                }}
              />
            )}
          </div>
          {/* US-9205: the graded price is the draft price. Say why in one line,
              and when a grade lands after the draft was priced from the comp
              median, OFFER the graded price; never move the number by itself. */}
          {priceWhy && !gradedOffer && (
            <p className="text-xs text-muted-foreground">{priceWhy}</p>
          )}
          {gradedOffer && !isEbayOrigin && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                className="rounded-md border px-2 py-1 font-medium hover:bg-muted"
                onClick={onUseGradedPrice}
              >
                Use graded price ${(gradedOffer.cents / 100).toFixed(2)}
              </button>
              <span className="text-muted-foreground">{gradedOffer.why}</span>
            </div>
          )}
          {/* US-2634: the price no longer waits for the Save button. Announced
              politely so a screen reader hears the save without losing the caret. */}
          {!isEbayOrigin && priceSaveState !== "idle" && (
            <p
              aria-live="polite"
              className={cn(
                "text-xs",
                priceSaveState === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {(priceIsLive ? LIVE_PRICE_SAVE_TEXT : PRICE_SAVE_TEXT)[
                priceSaveState
              ]}
            </p>
          )}
          {priceEstimated && (
            <p className="text-xs text-muted-foreground">
              {priceCompSource === "active_asking"
                ? "No sold comps were available, so this price is based on active eBay asking prices, which tend to run high. Verify before publishing."
                : "No eBay comps were found, so this price is the AI's estimate. Edit it to confirm."}
            </p>
          )}
        </div>
        {/* US-2250: quantity. listings.quantity was already read at
            publish and settable from AutoLister bulk-edit, but the
            single-item composer had no field — so five identical tees
            meant five items. An auction is single-quantity by definition,
            and a variation matrix owns the total, so both cases explain
            the number instead of offering a box that would be ignored. */}
        <div className="space-y-1.5">
          <Label htmlFor="listing-quantity">Quantity</Label>
          {listingFormat.format === "auction" ? (
            <p className="text-xs text-muted-foreground">
              Auctions sell one item. Switch to fixed price in Format
              &amp; variations to list more than one.
            </p>
          ) : variationQuantity != null ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {variationQuantity}
              </span>{" "}
              across your{" "}
              {listingFormat.variations?.variants.length ?? 0} variations —
              edit the per-variation counts in Format &amp; variations.
            </p>
          ) : (
            <>
              <Input
                id="listing-quantity"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="max-w-[7rem]"
                // US-2258: quantity is on EBAY_OWNED_LISTING_FIELDS, so on
                // a mirror the next inbound sync overwrites whatever is
                // typed here.
                disabled={isEbayOrigin}
                title={ebayOwnedHint}
              />
              {quantityInvalid ? (
                <p className="text-xs text-destructive">
                  Quantity must be at least 1.
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  How many of this item you have. Leave at 1 for a
                  one-of-a-kind piece.
                </p>
              )}
            </>
          )}
        </div>
        {/* US-1898: Best Offer — a conversion/negotiation lever, NOT a
            ranking factor. Fixed-price only (auctions use their own
            reserve/BIN terms). */}
        {listingFormat.format === "fixed_price" && (
          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Label htmlFor="best-offer" className="text-sm">
                  Accept Best Offers
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Let buyers negotiate — offers auto-clear within your limits. A
                  conversion lever, not a ranking factor.
                </p>
              </div>
              <Switch
                id="best-offer"
                checked={bestOfferEnabled}
                onCheckedChange={setBestOfferEnabled}
                aria-label="Accept Best Offers on this listing"
              />
            </div>
            {bestOfferEnabled && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="bo-accept" className="text-xs">
                    Auto-accept ≥ ($)
                  </Label>
                  <Input
                    id="bo-accept"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={bestOfferAccept}
                    onChange={(e) => setBestOfferAccept(e.target.value)}
                    placeholder="Leave blank"
                    className="h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bo-decline" className="text-xs">
                    Auto-decline ≤ ($)
                  </Label>
                  <Input
                    id="bo-decline"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={bestOfferDecline}
                    onChange={(e) => setBestOfferDecline(e.target.value)}
                    placeholder="Leave blank"
                    className="h-8"
                  />
                </div>
                {/* US-2405: blank means blank. These used to fall back to the
                    comp band, and the fallback got SAVED — so a listing repriced
                    later kept auto-accepting at the old band. */}
                <p className="col-span-2 text-[11px] text-muted-foreground">
                  Leave both blank to review every offer yourself. Type a number
                  only if you want offers cleared without you. eBay&apos;s rule:
                  decline &lt; accept &lt; price.
                </p>
                {lowAccept && (
                  <p className="col-span-2 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    {lowAccept}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}