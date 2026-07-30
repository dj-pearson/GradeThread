import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ListingRow } from "@/types/database";
export interface PromoteCardProps {
  promoteEnabled: boolean;
  setPromoteEnabled: (on: boolean) => void;
  promoMode: "cps" | "cpc" | "smart";
  setPromoMode: (mode: "cps" | "cpc" | "smart") => void;
  promoRate: string;
  setPromoRate: (next: string) => void;
  /** eBay's category suggestion, so the seller can revert to it. */
  promoSuggested: number | null;
  /** Read for the live ad status. */
  listing: ListingRow | null;
}
// US-561/US-1447: Promoted Listings. Cost-Per-Sale takes a % of the sale
// price; Cost-Per-Click (Priority) and Smart Targeting bid per click, so no % applies.
export function PromoteCard({
  promoteEnabled,
  setPromoteEnabled,
  promoMode,
  setPromoMode,
  promoRate,
  setPromoRate,
  promoSuggested,
  listing,
}: PromoteCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Promote on eBay</CardTitle>
            <CardDescription>
              Attach a Promoted Listings ad rate at publish for more
              visibility. You’re only charged this % of the sale price
              when the item sells through the ad.
            </CardDescription>
          </div>
          <Switch
            id="promote-toggle"
            checked={promoteEnabled}
            onCheckedChange={setPromoteEnabled}
            aria-label="Promote this listing on eBay"
          />
        </div>
      </CardHeader>
      {promoteEnabled && (
        <CardContent className="space-y-2">
          {/* US-1447: campaign type — Cost-Per-Sale vs Cost-Per-Click. */}
          <Label>Campaign type</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={promoMode === "cps" ? "default" : "outline"}
              size="sm"
              onClick={() => setPromoMode("cps")}
              className={promoMode === "cps" ? "bg-brand-navy" : undefined}
            >
              Cost-Per-Sale
            </Button>
            <Button
              type="button"
              variant={promoMode === "cpc" ? "default" : "outline"}
              size="sm"
              onClick={() => setPromoMode("cpc")}
              className={promoMode === "cpc" ? "bg-brand-navy" : undefined}
            >
              Cost-Per-Click (Priority)
            </Button>
            {/* US-1447: Smart Targeting — eBay auto-targets under a
                suggested max-CPC ceiling. */}
            <Button
              type="button"
              variant={promoMode === "smart" ? "default" : "outline"}
              size="sm"
              onClick={() => setPromoMode("smart")}
              className={promoMode === "smart" ? "bg-brand-navy" : undefined}
            >
              Smart Targeting
            </Button>
          </div>
          {promoMode === "cpc" ? (
            <p className="text-xs text-muted-foreground">
              Priority ads bid per click (charged when a shopper clicks,
              not only on sale). The bid uses your eBay Priority ad group&apos;s
              max cost-per-click. You can fine-tune bids in eBay Seller Hub.
            </p>
          ) : promoMode === "smart" ? (
            <p className="text-xs text-muted-foreground">
              Smart Targeting lets eBay pick placements and bids
              automatically, capped at a max cost-per-click seeded from
              eBay&apos;s suggestion for this listing. Charged per click; tune
              the ceiling any time in eBay Seller Hub.
            </p>
          ) : (
            <>
          <Label htmlFor="promo-rate">Ad rate (%)</Label>
          <div className="flex items-center gap-2">
            <Input
              id="promo-rate"
              type="number"
              inputMode="decimal"
              min="2"
              max="20"
              step="0.5"
              value={promoRate}
              onChange={(e) => setPromoRate(e.target.value)}
              className="h-9 max-w-[7rem]"
            />
            {promoSuggested != null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPromoRate(String(promoSuggested))}
                disabled={promoRate === String(promoSuggested)}
              >
                Use suggested ({promoSuggested}%)
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {promoSuggested != null
              ? `Suggested ${promoSuggested}% for this category. Adjust between 2% and 20%, or turn off to opt out.`
              : "Adjust between 2% and 20%, or turn off to opt out."}
          </p>
            </>
          )}
          {listing?.promo_status === "failed" && (
            <p className="text-xs text-destructive">
              The last publish couldn’t attach the ad on eBay. It’ll retry
              on your next publish.
            </p>
          )}
          {listing?.promo_ad_id && listing.promo_status &&
            listing.promo_status !== "failed" && (
              <p className="text-xs text-muted-foreground">
                Live ad status:{" "}
                <span className="font-medium">{listing.promo_status}</span>
                {listing.promo_rate_pct != null
                  ? ` at ${listing.promo_rate_pct}%`
                  : ""}
                .
              </p>
            )}
        </CardContent>
      )}
    </Card>
  );
}