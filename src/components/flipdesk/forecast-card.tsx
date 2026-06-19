import { useState } from "react";
import { Loader2, LineChart, TrendingDown, TrendingUp, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useResaleForecast,
  type ResaleForecast,
  type ResaleForecastInterval,
} from "@/hooks/use-resale-forecast";

// US-1104: Garment Passport resale-value & depreciation forecast surface for
// FlipDesk Scout. Forecasts list price / days-to-sell / 12-month resale value
// for a SKU class from the reseller's OWN sale ledger. Self-contained: brand is
// seeded from Scout's search; garment type is an optional narrower. Every number
// is labeled an ESTIMATE and degrades to a clear "not enough history" message.

function dollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function range(iv: ResaleForecastInterval | null): string {
  if (!iv) return "";
  return `${dollars(iv.lowCents)}–${dollars(iv.highCents)}`;
}

const QUALITY_BADGE: Record<ResaleForecast["dataQuality"], string> = {
  sufficient: "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300",
  sparse: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  insufficient: "bg-muted text-muted-foreground",
};

export function ForecastCard({ brand: seedBrand }: { brand?: string }) {
  const [brand, setBrand] = useState(seedBrand ?? "");
  const [garmentType, setGarmentType] = useState("");
  const forecast = useResaleForecast();
  const f = forecast.data;

  const canForecast = !!(brand.trim() || garmentType.trim());

  function run() {
    if (!canForecast) return;
    forecast.mutate({
      brand: brand.trim() || undefined,
      garment_type: garmentType.trim() || undefined,
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <LineChart className="h-5 w-5 text-brand-red-text" />
          Resale-value forecast
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Price, sell-through and 12-month depreciation for a SKU class, learned
          from <strong>your own</strong> sale history. Estimates, not guarantees.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-1">
            <Label htmlFor="forecast-brand">Brand</Label>
            <Input
              id="forecast-brand"
              placeholder="Patagonia"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-1">
            <Label htmlFor="forecast-type">Garment type (optional)</Label>
            <Input
              id="forecast-type"
              placeholder="jacket"
              value={garmentType}
              onChange={(e) => setGarmentType(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button onClick={run} disabled={!canForecast || forecast.isPending} className="w-full">
              {forecast.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Forecast
            </Button>
          </div>
        </div>

        {forecast.isError && (
          <p className="text-sm text-destructive">{forecast.error.message}</p>
        )}

        {f && f.dataQuality === "insufficient" && (
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{f.basis}</span>
          </div>
        )}

        {f && f.dataQuality !== "insufficient" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`rounded px-2 py-0.5 font-medium ${QUALITY_BADGE[f.dataQuality]}`}>
                {f.dataQuality === "sparse" ? "Limited data" : "Good data"}
              </span>
              <span className="text-muted-foreground">
                {f.sampleSize} sale{f.sampleSize === 1 ? "" : "s"} · confidence {Math.round(f.confidence * 100)}%
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Suggested list price</p>
                <p className="text-lg font-semibold">{dollars(f.listPriceCents)}</p>
                <p className="text-xs text-muted-foreground">{range(f.listPriceInterval)}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Expected days to sell</p>
                <p className="text-lg font-semibold">
                  {f.expectedDaysToSell != null ? `${f.expectedDaysToSell} days` : "—"}
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  Resale value in 12 mo
                  {f.annualDepreciationPct != null && (
                    f.annualDepreciationPct >= 0
                      ? <TrendingDown className="h-3 w-3 text-amber-600" />
                      : <TrendingUp className="h-3 w-3 text-green-600" />
                  )}
                </p>
                <p className="text-lg font-semibold">{dollars(f.resaleValue12moCents)}</p>
                <p className="text-xs text-muted-foreground">
                  {range(f.resaleValue12moInterval)}
                  {f.annualDepreciationPct != null && ` · ${Math.abs(f.annualDepreciationPct)}%/yr ${f.annualDepreciationPct >= 0 ? "down" : "up"}`}
                </p>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{f.basis}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
