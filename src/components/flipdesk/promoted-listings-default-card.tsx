import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
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
import {
  useSellerPromoDefaults,
  useUpdateSellerPromoDefaults,
} from "@/hooks/use-seller-promo-defaults";

// eBay accepts 2–20% here (mirrors MIN/MAX_AD_RATE_PCT in the edge).
const MIN_RATE = 2;
const MAX_RATE = 20;

type PromoMode = "cps" | "cpc" | "smart";

const MODE_LABELS: Record<PromoMode, string> = {
  cps: "Cost-per-sale (only pay when it sells)",
  cpc: "Cost-per-click (Priority)",
  smart: "Smart (eBay-optimized)",
};

// 00432: seller-level Promoted-Listings defaults. Promotion is OFF by default;
// turning this on promotes new/un-configured listings, while a per-listing
// choice in the composer still overrides it.
export function PromotedListingsDefaultCard() {
  const { data: defaults, isLoading } = useSellerPromoDefaults();
  const update = useUpdateSellerPromoDefaults();

  const [enabled, setEnabled] = useState(false);
  const [rate, setRate] = useState("");
  const [mode, setMode] = useState<PromoMode>("cps");

  // Seed once the saved defaults load.
  useEffect(() => {
    if (!defaults) return;
    setEnabled(defaults.promote_listings_by_default);
    setRate(
      defaults.default_promo_rate_pct != null
        ? String(defaults.default_promo_rate_pct)
        : "",
    );
    setMode(
      defaults.default_promo_mode === "cpc" ||
        defaults.default_promo_mode === "smart"
        ? defaults.default_promo_mode
        : "cps",
    );
  }, [defaults]);

  async function save(next: {
    promote_listings_by_default?: boolean;
    default_promo_rate_pct?: number | null;
    default_promo_mode?: string | null;
  }) {
    try {
      await update.mutateAsync(next);
    } catch (err) {
      toastError(err, "Couldn't save.");
    }
  }

  function onToggle(on: boolean) {
    setEnabled(on);
    void save({ promote_listings_by_default: on });
  }

  // Persist the rate on blur, clamped; a blank box means "use the category
  // suggestion" (stored null).
  function commitRate() {
    const trimmed = rate.trim();
    if (trimmed === "") {
      void save({ default_promo_rate_pct: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      toast.error("Enter a number between 2 and 20.");
      return;
    }
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, n));
    setRate(String(clamped));
    void save({ default_promo_rate_pct: clamped });
  }

  function onModeChange(v: string) {
    const m = (v === "cpc" || v === "smart" ? v : "cps") as PromoMode;
    setMode(m);
    void save({ default_promo_mode: m });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          Promoted Listings
        </CardTitle>
        <CardDescription>
          eBay Promoted Listings default for new listings. Off by default — you
          only pay an ad fee when a promoted item sells. You can still override
          this per listing in the composer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Promote new listings by default</p>
            <p className="text-xs text-muted-foreground">
              When on, every new listing is promoted unless you turn it off for
              that listing. When off, listings are promoted only if you opt them
              in individually.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={isLoading || update.isPending}
            aria-label="Promote new listings by default"
          />
        </div>

        {enabled && (
          <>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="defaultAdRate">Default ad rate (%)</Label>
                <Input
                  id="defaultAdRate"
                  type="number"
                  inputMode="decimal"
                  min={MIN_RATE}
                  max={MAX_RATE}
                  step={0.5}
                  placeholder="Category suggestion"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  onBlur={commitRate}
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank to use eBay&apos;s category-based suggestion
                  ({MIN_RATE}–{MAX_RATE}%).
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="defaultPromoMode">Default campaign type</Label>
                <Select value={mode} onValueChange={onModeChange}>
                  <SelectTrigger id="defaultPromoMode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(MODE_LABELS) as PromoMode[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
