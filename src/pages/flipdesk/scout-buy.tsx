import { useRef, useState } from "react";
import {
  Camera,
  Loader2,
  ScanBarcode,
  Sparkles,
  Info,
  ThumbsUp,
  ThumbsDown,
  CircleHelp,
  PackagePlus,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import {
  useScoutAppraise,
  useScoutBuy,
  type AppraiseResult,
  type BuyRecommendation,
} from "@/hooks/use-scout-appraise";
import { ValueBasisNote } from "@/components/value/value-basis-note";

function dollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

// Parse a dollars string ("12.50") to integer cents, or null when blank/invalid.
function toCents(input: string): number | null {
  const n = Number(input.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

const REC_STYLES: Record<BuyRecommendation, { label: string; className: string; Icon: typeof ThumbsUp }> = {
  buy: {
    label: "BUY",
    className: "bg-green-100 text-green-800 border-green-300 dark:bg-green-950/50 dark:text-green-300 dark:border-green-800",
    Icon: ThumbsUp,
  },
  maybe: {
    label: "MAYBE",
    className: "bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-950/50 dark:text-yellow-300 dark:border-yellow-800",
    Icon: CircleHelp,
  },
  skip: {
    label: "SKIP",
    className: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800",
    Icon: ThumbsDown,
  },
};

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("font-semibold", accent && "text-green-700 dark:text-green-300")}>{value}</div>
    </div>
  );
}

function DecisionCard({
  result,
  keyword,
  brand,
  size,
  costCents,
}: {
  result: AppraiseResult;
  keyword: string;
  brand: string;
  size: string;
  costCents: number | null;
}) {
  const buy = useScoutBuy();
  const { decision, grade, value, sellThrough } = result;
  const rec = REC_STYLES[decision.recommendation];

  return (
    <div className="space-y-3">
      <Card className={cn("border-2", rec.className)}>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center gap-3">
            <rec.Icon className="h-8 w-8" />
            <div>
              <div className="text-2xl font-bold leading-none">{rec.label}</div>
              <p className="mt-1 text-sm">{decision.reason}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Condition"
              value={grade.value != null ? `${grade.value.toFixed(1)}${grade.tier ? ` · ${grade.tier}` : ""}` : "Not graded"}
            />
            <Stat
              label="Est. resale"
              value={value.sufficient ? `${dollars(value.lowCents)}–${dollars(value.highCents)}` : "Low comps"}
            />
            <Stat
              label="Sell-through"
              value={
                sellThrough.label === "unknown"
                  ? "—"
                  : `${Math.round(sellThrough.sellThroughPct * 100)}% · ${sellThrough.daysLow}–${sellThrough.daysHigh}d`
              }
            />
            <Stat label="Breakeven" value={dollars(decision.breakevenCents)} />
          </div>

          {/* US-2850: the resale range above is the number this whole screen
              turns into a buy or a pass, so it does not get to appear without
              saying what it is and how much sample is behind it. */}
          <ValueBasisNote basis={value.basis} className="border-t pt-3" />

          {costCents != null && (
            <div className="grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-4">
              <Stat label="Your cost" value={dollars(costCents)} />
              <Stat label="Net resale" value={dollars(decision.estProceedsCents)} />
              <Stat
                label="Est. profit"
                value={dollars(decision.estMarginCents)}
                accent={decision.estMarginCents != null && decision.estMarginCents > 0}
              />
              <Stat
                label="ROI"
                value={decision.roiPct != null ? `${Math.round(decision.roiPct * 100)}%` : "—"}
                accent={decision.roiPct != null && decision.roiPct > 0}
              />
            </div>
          )}

          {grade.value != null && grade.confidence < 0.6 && (
            <div className="flex items-start gap-2 rounded-md bg-background/60 p-2 text-xs">
              <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              Low grade confidence ({Math.round(grade.confidence * 100)}%) — inspect the item closely in person.
            </div>
          )}

          <Button
            type="button"
            // Also disable once the add succeeds so a second click can't create a
            // duplicate inventory record. (buy.mutate surfaces failures via the
            // hook's onError toast.)
            disabled={buy.isPending || buy.isSuccess}
            onClick={() =>
              buy.mutate({
                // US-2763: only an AUTHORITATIVE match may name the item.
                // A visual match is a look-alike listing's title, and saving it
                // silently is how a garment with no brand mark in frame ends up
                // named after somebody else's Lululemon tank. What the seller
                // typed wins over a guess; the guess is shown, not stored.
                title: (result.identityIsAuthoritative ? result.matchedTitle : null) ||
                  keyword.trim() || "Scout item",
                brand: brand.trim() || undefined,
                size: size.trim() || undefined,
                costCents: costCents ?? undefined,
                targetCents: value.medianCents ?? undefined,
                gradeValue: grade.value ?? undefined,
                gradeLabel: grade.tier ?? undefined,
              })
            }
          >
            {buy.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PackagePlus className="mr-2 h-4 w-4" />
            )}
            {buy.isSuccess ? "Added to inventory" : "Bought it — add to inventory"}
          </Button>
        </CardContent>
      </Card>

      {result.disclaimer && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{result.disclaimer}</span>
        </div>
      )}
    </div>
  );
}

export function FlipdeskScoutBuyPage() {
  const [photo, setPhoto] = useState<string | null>(null);
  const [barcode, setBarcode] = useState("");
  const [keyword, setKeyword] = useState("");
  const [brand, setBrand] = useState("");
  const [size, setSize] = useState("");
  const [categoryId, setCategoryId] = useState("11450"); // Clothing, Shoes & Accessories
  const [cost, setCost] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const appraise = useScoutAppraise();
  const result = appraise.data;
  const submittedCost = result ? result.costCents : null;

  function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setPhoto(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  }

  const canAppraise =
    (photo || barcode.trim() || keyword.trim()) &&
    (barcode.trim() || keyword.trim() || categoryId.trim());

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canAppraise) return;
    appraise.mutate({
      image: photo ?? undefined,
      barcode: barcode.trim() || undefined,
      q: keyword.trim() || undefined,
      brand: brand.trim() || undefined,
      categoryId: categoryId.trim() || undefined,
      size: size.trim() || undefined,
      costCents: toCents(cost) ?? undefined,
    });
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 p-4 sm:p-6">
      <PageHeader
        icon={Sparkles}
        title="Buy decision"
        subtitle={
          <>
            In the field, before you buy: snap the item (or scan its barcode), add
            what you'd pay, and get an instant <strong>buy / maybe / skip</strong>
            with condition, resale range, sell-through, and ROI.
          </>
        }
      />

      <Card>
        <CardContent className="space-y-4 p-4">
          <form onSubmit={submit} className="space-y-4">
            {/* Photo capture */}
            <div className="space-y-1">
              <Label>Item photo</Label>
              {photo ? (
                <div className="relative w-fit">
                  <img src={photo} alt="Item" className="h-40 rounded-md object-cover" />
                  <button
                    type="button"
                    onClick={() => {
                      setPhoto(null);
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                    className="absolute -right-2 -top-2 rounded-full bg-background p-1 shadow ring-1 ring-border"
                    aria-label="Remove photo"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => fileRef.current?.click()}
                >
                  <Camera className="mr-2 h-4 w-4" /> Take / choose photo
                </Button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={onPickPhoto}
              />
              <p className="text-xs text-muted-foreground">
                A photo gives a condition signal. Without one you'll still get value
                + ROI at "used" condition.
              </p>
            </div>

            {/* Barcode */}
            <div className="space-y-1">
              <Label htmlFor="scout-barcode">Barcode / UPC (optional)</Label>
              <div className="relative">
                <ScanBarcode className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="scout-barcode"
                  className="pl-8"
                  inputMode="numeric"
                  placeholder="012345678905"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="scout-keyword">Keyword</Label>
                <Input
                  id="scout-keyword"
                  placeholder="Patagonia Better Sweater"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="scout-brand">Brand (optional)</Label>
                <Input
                  id="scout-brand"
                  placeholder="Patagonia"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="scout-size">Size (optional)</Label>
                <Input
                  id="scout-size"
                  placeholder="M"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="scout-category">eBay category ID</Label>
                <Input
                  id="scout-category"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="scout-cost">Your cost (what you'd pay)</Label>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  id="scout-cost"
                  className="pl-6"
                  inputMode="decimal"
                  placeholder="8.00"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={!canAppraise || appraise.isPending}>
              {appraise.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Should I buy it?
            </Button>
          </form>
        </CardContent>
      </Card>

      {appraise.isPending ? (
        <div className="h-48 w-full animate-pulse rounded-lg bg-muted" />
      ) : appraise.isError ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Appraisal failed</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {appraise.error.message}
          </CardContent>
        </Card>
      ) : result ? (
        <DecisionCard
          result={result}
          keyword={keyword}
          brand={brand}
          size={size}
          costCents={submittedCost}
        />
      ) : null}
    </div>
  );
}
