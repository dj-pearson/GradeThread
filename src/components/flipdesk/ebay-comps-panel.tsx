import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Loader2,
  AlertCircle,
  ExternalLink,
  ImageOff,
  TrendingUp,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEbayComps } from "@/hooks/use-ebay";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

interface Props {
  itemId: string;
  categoryId: string | null;
  // Brand / size filters tighten the comp set — passed in from the item.
  brand: string | null;
  size: string | null;
  // Free-text query, usually the item's title minus brand+size.
  q: string;
  // The composer needs to update its preview when target_price changes.
  onTargetPriceUpdated?: (value: number) => void;
}

function fmt(value: number | null, currency: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function EbayCompsPanel({
  itemId,
  categoryId,
  brand,
  size,
  q,
  onTargetPriceUpdated,
}: Props) {
  const qc = useQueryClient();
  const query = useEbayComps({
    categoryId,
    q: q || undefined,
    brand: brand || undefined,
    size: size || undefined,
    limit: 12,
  });

  const stats = query.data?.stats;
  const comps = query.data?.items ?? [];

  // The "recommended price" is the median, but we display it as a band
  // (p25..p75) so the user sees the realistic range, not a single point.
  const recommendedPrice = stats?.median ?? null;
  const currency = stats?.currency ?? "USD";

  const usingFilters = useMemo(() => {
    const parts: string[] = [];
    if (brand) parts.push(`brand:${brand}`);
    if (size) parts.push(`size:${size}`);
    return parts;
  }, [brand, size]);

  async function applyAsTargetPrice() {
    if (recommendedPrice == null) return;
    const rounded = Math.round(recommendedPrice * 100) / 100;
    const { error } = await supabase
      .from("inventory_items")
      .update({ target_price: rounded } as never)
      .eq("id", itemId);
    if (error) {
      toast.error(`Failed to update target price: ${error.message}`);
      return;
    }
    onTargetPriceUpdated?.(rounded);
    qc.invalidateQueries({ queryKey: ["items_full"] });
    qc.invalidateQueries({ queryKey: ["inventory_item_ebay", itemId] });
    toast.success(`Target price set to ${fmt(rounded, currency)}.`);
  }

  if (!categoryId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Comps &amp; pricing
          </CardTitle>
          <CardDescription>
            Pick an eBay category above — comps and a recommended price will
            appear here.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Comps &amp; pricing
            </CardTitle>
            <CardDescription>
              Active eBay listings in this category
              {usingFilters.length > 0
                ? ` filtered by ${usingFilters.join(", ")}`
                : ""}
              .
            </CardDescription>
          </div>
          {query.isFetching && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isError && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {(query.error as Error).message}
          </div>
        )}

        {/* Price band */}
        {stats && stats.count > 0 ? (
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Recommended price
                </div>
                <div className="text-2xl font-bold text-brand-navy dark:text-foreground">
                  {fmt(recommendedPrice, currency)}
                </div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                Typical range
                <div className="text-sm font-medium text-foreground">
                  {fmt(stats.p25, currency)} – {fmt(stats.p75, currency)}
                </div>
              </div>
            </div>
            <PriceBand stats={stats} />
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="text-[11px] text-muted-foreground">
                {stats.count} of {query.data?.total ?? stats.count} active comps
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={applyAsTargetPrice}
                disabled={recommendedPrice == null}
              >
                Use as target price
              </Button>
            </div>
            {/* US-460: be explicit about the limitation. These are CURRENT
                ASKING prices from active listings, not final SOLD prices —
                sellers routinely list above what items actually sell for. eBay's
                sold-price feed (Marketplace Insights API) requires restricted
                production access we don't currently hold, so we surface the
                caveat rather than imply these are realized sale prices. */}
            <div className="mt-2 flex items-start gap-1.5 border-t pt-2 text-[11px] text-muted-foreground">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                Asking prices from <strong>active</strong> listings, not sold
                prices — actual sale prices are often lower. Treat the
                recommended price as a ceiling.
              </span>
            </div>
          </div>
        ) : query.isLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading comps…
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No active comps in this category with these filters. Try clearing
            brand or size on the item.
          </div>
        )}

        {/* Comp grid */}
        {comps.length > 0 && (
          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Comparable listings
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {comps.map((c) => (
                <a
                  key={c.itemId}
                  href={c.itemWebUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block overflow-hidden rounded-md border bg-card transition-colors hover:border-brand-navy"
                >
                  <div className="relative aspect-square bg-muted/40">
                    {c.imageUrl ? (
                      <img
                        src={c.imageUrl}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                        <ImageOff className="h-5 w-5" />
                      </div>
                    )}
                    <ExternalLink className="absolute right-1 top-1 h-3 w-3 text-white drop-shadow opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <div className="p-2">
                    <div className="text-sm font-semibold text-brand-navy dark:text-foreground">
                      {fmt(c.price, c.currency)}
                    </div>
                    <div className="line-clamp-2 text-[11px] leading-tight text-muted-foreground">
                      {c.title}
                    </div>
                    {c.condition && (
                      <Badge
                        variant="outline"
                        className="mt-1 text-[9px] font-normal"
                      >
                        {c.condition}
                      </Badge>
                    )}
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Active comps only. Sold-price comps unlock when eBay approves the
          Marketplace Insights API (Week 3).
        </p>
      </CardContent>
    </Card>
  );
}

// Mini sparkline-ish visual for the price distribution. Renders min..max as
// a track, p25..p75 as the IQR box, and the median as a notch.
function PriceBand({
  stats,
}: {
  stats: {
    min: number | null;
    p25: number | null;
    median: number | null;
    p75: number | null;
    max: number | null;
  };
}) {
  if (
    stats.min == null ||
    stats.max == null ||
    stats.max <= stats.min ||
    stats.p25 == null ||
    stats.p75 == null
  ) {
    return null;
  }
  const range = stats.max - stats.min;
  const pct = (v: number) => `${((v - stats.min!) / range) * 100}%`;

  return (
    <div className="relative h-2 rounded-full bg-muted">
      <div
        className="absolute top-0 h-full rounded-full bg-brand-navy/30"
        style={{
          left: pct(stats.p25),
          width: `calc(${pct(stats.p75)} - ${pct(stats.p25)})`,
        }}
      />
      {stats.median != null && (
        <div
          className={cn(
            "absolute top-1/2 -translate-y-1/2 h-3 w-1 rounded-full bg-brand-red shadow"
          )}
          style={{ left: pct(stats.median) }}
        />
      )}
    </div>
  );
}
