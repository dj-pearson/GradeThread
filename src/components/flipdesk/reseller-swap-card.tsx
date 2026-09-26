import { ExternalLink, EyeOff, Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatCents } from "@/lib/ledger-math";
import {
  useDismissSwapTip,
  useSwapSettings,
  useSwapTips,
  useUpdateSwapSettings,
  type SwapTip,
} from "@/hooks/use-reseller-swap";

// US-3541: Reseller Swap on the Radar page.
//
// Two switches and a list. The switches are separate on purpose: a seller can
// share their stale stock without wanting tips, or want tips without sharing.
// Every tip links straight to the other seller's eBay listing; the sale happens
// on eBay, so the copy never says "buy" from us, and it says plainly that we
// may earn a commission from eBay (FTC disclosure).

const STALE_CHOICES = [30, 60, 90, 120];

export function ResellerSwapCard() {
  const settings = useSwapSettings();
  const update = useUpdateSwapSettings();
  const receiving = settings.data?.receive_tips ?? false;
  const tips = useSwapTips(receiving);
  const dismiss = useDismissSwapTip();

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Repeat className="h-4 w-4" aria-hidden="true" />
            Reseller Swap
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            Stuck items from other GradeThread sellers, matched to the brands
            you sell fastest. You buy on eBay like any buyer, so eBay handles
            payment, shipping and returns. Other sellers never see your sales
            numbers, and you never see theirs.
          </p>
        </div>

        {settings.isError && (
          <p className="text-sm text-destructive">
            {settings.error.message}
          </p>
        )}

        {settings.data && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-start gap-3">
              <Switch
                id="swap-receive"
                checked={settings.data.receive_tips}
                disabled={update.isPending}
                onCheckedChange={(v) => update.mutate({ receive_tips: v })}
              />
              <Label htmlFor="swap-receive" className="block space-y-0.5 font-normal">
                <span className="block text-sm font-medium">Show me tips</span>
                <span className="block text-xs text-muted-foreground">
                  Other sellers' stuck listings in brands you move fast.
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <Switch
                id="swap-share"
                checked={settings.data.share_stale}
                disabled={update.isPending}
                onCheckedChange={(v) => update.mutate({ share_stale: v })}
              />
              <div className="space-y-1">
                <Label htmlFor="swap-share" className="block space-y-0.5 font-normal">
                  <span className="block text-sm font-medium">Share my stuck listings</span>
                  <span className="block text-xs text-muted-foreground">
                    Only what eBay already shows is shared.
                  </span>
                </Label>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  Stuck after
                  <select
                    className="rounded border bg-background px-1 text-xs"
                    value={settings.data.stale_after_days}
                    disabled={update.isPending}
                    onChange={(e) =>
                      update.mutate({ stale_after_days: Number(e.target.value) })}
                  >
                    {[...new Set([...STALE_CHOICES, settings.data.stale_after_days])]
                      .sort((a, b) => a - b)
                      .map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                  </select>
                  days on eBay
                </label>
              </div>
            </div>
          </div>
        )}

        {receiving && <TipList tips={tips} onDismiss={(id) => dismiss.mutate(id)} />}

        <p className="text-xs text-muted-foreground">
          GradeThread may earn a commission from eBay when you buy through these
          links. It does not change your price or the seller's payout.
        </p>
      </CardContent>
    </Card>
  );
}

function TipList({
  tips,
  onDismiss,
}: {
  tips: ReturnType<typeof useSwapTips>;
  onDismiss: (itemId: string) => void;
}) {
  if (tips.isLoading) {
    return <p className="text-sm text-muted-foreground">Finding matches…</p>;
  }
  if (tips.isError) {
    return <p className="text-sm text-destructive">{tips.error.message}</p>;
  }
  const data = tips.data;
  if (!data) return null;
  if (data.fit_brands.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No matches yet. Tips start once you have sold at least two items of the
        same brand in the last six months.
      </p>
    );
  }
  if (data.tips.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing stuck right now in your fast brands (
        {data.fit_brands.slice(0, 4).map((b) => b.brand).join(", ")}). Check back
        later.
      </p>
    );
  }
  return (
    <ul className="divide-y">
      {data.tips.map((tip) => (
        <TipRow key={tip.item_id} tip={tip} onDismiss={onDismiss} />
      ))}
    </ul>
  );
}

function TipRow({ tip, onDismiss }: { tip: SwapTip; onDismiss: (id: string) => void }) {
  const speed =
    tip.fit.median_days != null ? `, usually in ${tip.fit.median_days} days` : "";
  return (
    <li className="flex gap-3 py-3">
      {tip.photo_url ? (
        <img
          src={tip.photo_url}
          alt=""
          loading="lazy"
          className="h-16 w-16 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="h-16 w-16 shrink-0 rounded-md bg-muted" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium">{tip.title}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {tip.price_cents != null && (
            <span className="tabular-nums text-foreground">{formatCents(tip.price_cents)}</span>
          )}
          {tip.size && <span>Size {tip.size}</span>}
          <span>Listed {tip.days_listed} days</span>
          {tip.grade_value != null && (
            <Badge variant="secondary">
              Grade {tip.grade_value.toFixed(1)}
              {tip.grade_label ? ` ${tip.grade_label}` : ""}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          You sold {tip.fit.sold} {tip.brand}
          {speed}.
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Button asChild size="sm" variant="outline">
          <a href={tip.url} target="_blank" rel="noopener noreferrer sponsored">
            View on eBay
            <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onDismiss(tip.item_id)}
        >
          <EyeOff className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Hide
        </Button>
      </div>
    </li>
  );
}
