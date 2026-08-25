import { useEffect, useState } from "react";
import { Tag } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AUCTION_DURATIONS, AUCTION_DURATION_LABELS } from "@/lib/constants";
import {
  useSellerListingDefaults,
  useUpdateSellerListingDefaults,
  type SellerListingDefaults,
} from "@/hooks/use-seller-listing-defaults";
import type { ListingFormat } from "@/types/database";

// US-2852 / migration 00668. Everything here SEEDS a new draft and nothing more.
// A listing you already saved keeps its own values, so changing a default never
// reaches back into work in progress — the card says so, because a settings
// screen that silently rewrites live listings is the version of this feature
// nobody wants.
const MAX_QUANTITY = 999;

export function ListingDefaultsCard() {
  const { data: defaults, isLoading } = useSellerListingDefaults();
  const update = useUpdateSellerListingDefaults();

  const [format, setFormat] = useState<ListingFormat>("fixed_price");
  const [duration, setDuration] = useState("DAYS_7");
  const [bestOffer, setBestOffer] = useState(false);
  const [bestOfferAuction, setBestOfferAuction] = useState(false);
  const [acceptPct, setAcceptPct] = useState("");
  const [declinePct, setDeclinePct] = useState("");
  const [quantity, setQuantity] = useState("");

  useEffect(() => {
    if (!defaults) return;
    setFormat(defaults.default_listing_format === "auction" ? "auction" : "fixed_price");
    setDuration(defaults.default_auction_duration ?? "DAYS_7");
    setBestOffer(defaults.default_best_offer_enabled);
    setBestOfferAuction(defaults.default_best_offer_on_auction);
    setAcceptPct(
      defaults.default_best_offer_accept_pct != null
        ? String(defaults.default_best_offer_accept_pct)
        : "",
    );
    setDeclinePct(
      defaults.default_best_offer_decline_pct != null
        ? String(defaults.default_best_offer_decline_pct)
        : "",
    );
    setQuantity(
      defaults.default_listing_quantity != null
        ? String(defaults.default_listing_quantity)
        : "",
    );
  }, [defaults]);

  async function save(next: Partial<SellerListingDefaults>) {
    try {
      await update.mutateAsync(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  }

  const busy = isLoading || update.isPending;

  // A blank percent box means "leave the threshold blank on the draft" (null).
  // Anything outside 1-99 is rejected rather than clamped: 0% and 100% are not
  // near-misses of a valid rate, they are a different intention typed wrong.
  function commitPct(
    raw: string,
    setRaw: (v: string) => void,
    column: "default_best_offer_accept_pct" | "default_best_offer_decline_pct",
  ) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      void save({ [column]: null } as Partial<SellerListingDefaults>);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) {
      toast.error("Enter a percent between 1 and 99, or leave it blank.");
      setRaw("");
      void save({ [column]: null } as Partial<SellerListingDefaults>);
      return;
    }
    const rounded = Math.round(n * 10) / 10;
    setRaw(String(rounded));
    void save({ [column]: rounded } as Partial<SellerListingDefaults>);
  }

  function commitQuantity() {
    const trimmed = quantity.trim();
    if (trimmed === "") {
      void save({ default_listing_quantity: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 1) {
      toast.error("Enter a whole number of 1 or more, or leave it blank.");
      setQuantity("");
      void save({ default_listing_quantity: null });
      return;
    }
    const clamped = Math.min(MAX_QUANTITY, Math.floor(n));
    setQuantity(String(clamped));
    void save({ default_listing_quantity: clamped });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tag className="h-5 w-5 text-primary" />
          Listing defaults
        </CardTitle>
        <CardDescription>
          How a brand-new listing opens in the composer. These only apply to
          listings you have not saved yet — nothing here changes a draft or a live
          listing, and you can override any of it per listing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="defaultListingFormat">Format</Label>
            <Select
              value={format}
              onValueChange={(v) => {
                const f = v === "auction" ? "auction" : "fixed_price";
                setFormat(f);
                void save({ default_listing_format: f });
              }}
            >
              <SelectTrigger id="defaultListingFormat" disabled={busy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed_price">Fixed price (Buy It Now)</SelectItem>
                <SelectItem value="auction">Auction</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {format === "auction" ? (
            <div className="space-y-1.5">
              <Label htmlFor="defaultAuctionDuration">Auction length</Label>
              <Select
                value={duration}
                onValueChange={(v) => {
                  setDuration(v);
                  void save({ default_auction_duration: v });
                }}
              >
                <SelectTrigger id="defaultAuctionDuration" disabled={busy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUCTION_DURATIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {AUCTION_DURATION_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="defaultQuantity">Quantity</Label>
              <Input
                id="defaultQuantity"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_QUANTITY}
                step={1}
                placeholder="1"
                value={quantity}
                disabled={busy}
                onChange={(e) => setQuantity(e.target.value)}
                onBlur={commitQuantity}
              />
              <p className="text-xs text-muted-foreground">
                Leave blank for 1. Useful if you usually list multiples of the
                same item.
              </p>
            </div>
          )}
        </div>

        <Separator />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Turn on Best Offer</p>
            <p className="text-xs text-muted-foreground">
              New fixed-price listings open with Best Offer already on. Buyers can
              send you a price instead of paying the asking price.
            </p>
          </div>
          <Switch
            checked={bestOffer}
            disabled={busy}
            onCheckedChange={(on) => {
              setBestOffer(on);
              void save({ default_best_offer_enabled: on });
            }}
            aria-label="Turn on Best Offer for new fixed-price listings"
          />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Best Offer on auctions too</p>
            <p className="text-xs text-muted-foreground">
              Kept separate on purpose: an accepted offer ends an auction early,
              so most sellers want this off even when they use Best Offer on
              fixed-price listings.
            </p>
          </div>
          <Switch
            checked={bestOfferAuction}
            disabled={busy}
            onCheckedChange={(on) => {
              setBestOfferAuction(on);
              void save({ default_best_offer_on_auction: on });
            }}
            aria-label="Turn on Best Offer for new auction listings"
          />
        </div>

        {(bestOffer || bestOfferAuction) && (
          <>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="defaultAcceptPct">Auto-accept at (% of price)</Label>
                <Input
                  id="defaultAcceptPct"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={99}
                  step={1}
                  placeholder="No auto-accept"
                  value={acceptPct}
                  disabled={busy}
                  onChange={(e) => setAcceptPct(e.target.value)}
                  onBlur={() =>
                    commitPct(acceptPct, setAcceptPct, "default_best_offer_accept_pct")
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="defaultDeclinePct">Auto-decline below (% of price)</Label>
                <Input
                  id="defaultDeclinePct"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={99}
                  step={1}
                  placeholder="No auto-decline"
                  value={declinePct}
                  disabled={busy}
                  onChange={(e) => setDeclinePct(e.target.value)}
                  onBlur={() =>
                    commitPct(declinePct, setDeclinePct, "default_best_offer_decline_pct")
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Stored as a percent so the same setting works on a $12 tee and a
              $600 jacket. The composer turns it into a dollar amount when it
              opens the listing, and that dollar amount is what gets saved — later
              price changes do not move it.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
