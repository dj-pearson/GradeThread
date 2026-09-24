import { useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
  type AppraiseInput,
  type AppraiseResult,
  type BuyRecommendation,
} from "@/hooks/use-scout-appraise";
import { compressImage } from "@/lib/image-utils";
import { inventoryItemHref } from "@/lib/scout-links";
import { ValueBasisNote } from "@/components/value/value-basis-note";
import { SourcingCeilingNote } from "@/components/value/sourcing-ceiling-note";
import { SourcingTargetSetting } from "@/components/flipdesk/sourcing-target-setting";
import { EbayAttribution } from "@/components/marketplace/ebay-attribution";
import { usePageHost } from "@/hooks/use-page-host";

function dollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/** SRC-12: the grading contract's review line, the same one grading uses. */
export const BUY_REVIEW_CONFIDENCE = 0.75;

/** Blob to a data: URI. */
function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read that photo."));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read that photo."));
    reader.readAsDataURL(blob);
  });
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
  appraised,
  costCents,
  onNextItem,
}: {
  result: AppraiseResult;
  /**
   * SRC-12: what was APPRAISED, snapshotted from the mutation's variables. The
   * form fields are live, so a seller who retyped the brand after the verdict
   * used to save the new words against the old verdict.
   */
  appraised: AppraiseInput;
  costCents: number | null;
  onNextItem: () => void;
}) {
  const qc = useQueryClient();
  const buy = useScoutBuy();
  const { decision, grade, value, sellThrough, ceiling } = result;
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

          {/* US-2851: the one number a seller acts on with cash in hand. It
              sits above the provenance line on purpose, and it is absent rather
              than guessed when the cell has no measured curve. */}
          <SourcingCeilingNote ceiling={ceiling} className="border-t pt-3" />

          {/* US-2850: the resale range above is the number this whole screen
              turns into a buy or a pass, so it does not get to appear without
              saying what it is and how much sample is behind it. */}
          <ValueBasisNote basis={value.basis} />

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

          {/* SRC-12: the grading contract's line is 0.75, and a grade the
              engine already flagged for review is uncertain whatever its
              number says. This used 0.6 and ignored the flag. */}
          {grade.value != null && (grade.needsHumanReview || grade.confidence < BUY_REVIEW_CONFIDENCE) && (
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
              buy.mutate(
                {
                  // US-2763: only an AUTHORITATIVE match may name the item.
                  // A visual match is a look-alike listing's title, and saving it
                  // silently is how a garment with no brand mark in frame ends up
                  // named after somebody else's Lululemon tank. What the seller
                  // typed wins over a guess; the guess is shown, not stored.
                  title: (result.identityIsAuthoritative ? result.matchedTitle : null) ||
                    appraised.q?.trim() || "Scout item",
                  brand: appraised.brand?.trim() || undefined,
                  size: appraised.size?.trim() || undefined,
                  // SRC-12 / US-3100: the leaf the appraisal resolved, else the
                  // one the seller asked about.
                  categoryId: result.matchedCategoryId ?? appraised.categoryId ?? undefined,
                  costCents: costCents ?? undefined,
                  // SRC-12: a thin-comp median is not a price to aim at. Sent
                  // only when the value range was sufficient.
                  targetCents: value.sufficient ? (value.medianCents ?? undefined) : undefined,
                  gradeValue: grade.value ?? undefined,
                  gradeLabel: grade.tier ?? undefined,
                },
                {
                  onSuccess: () => {
                    void qc.invalidateQueries({ queryKey: ["items_full"] });
                  },
                },
              )
            }
          >
            {buy.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PackagePlus className="mr-2 h-4 w-4" />
            )}
            {buy.isSuccess ? "Added to inventory" : "Bought it — add to inventory"}
          </Button>

          {/* SRC-12: what to do after "Bought it". The id used to be dropped,
              so there was no way to the new item and nothing reset the form
              for the next one on the rack. */}
          {buy.isSuccess && buy.data?.id ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to={inventoryItemHref(buy.data.id)}>Open item</Link>
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onNextItem}>
                Next item
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {result.disclaimer && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{result.disclaimer}</span>
        </div>
      )}

      {/* US-3042: the resale range, the sell-through and the matched title on
          this screen are all read out of other sellers' live eBay listings
          through the Browse API. It is a smaller surface than Scout because it
          shows an aggregate rather than the rows, but the source is the same and
          so is eBay's requirement. */}
      <EbayAttribution what="Resale value and sell-through" />
    </div>
  );
}

export function FlipdeskScoutBuyPage() {
  // SRC-11: inside the Sourcing host the host owns width and gutter.
  const { embedded } = usePageHost();
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

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("That file isn't a photo. Pick a JPEG, PNG or HEIC image.");
      return;
    }
    // SRC-12: a phone photo is 4-8 MB, which base64 turns into a request body
    // near the edge's 12 MB cap. 1600px is plenty for a condition read.
    try {
      let blob: Blob = file;
      try {
        blob = (await compressImage(file, 1600, 0.85)).blob;
      } catch {
        // A photo the canvas cannot decode is still sent as it is; the edge
        // enforces its own cap.
      }
      setPhoto(await blobToDataUri(blob));
    } catch {
      toast.error("Couldn't read that photo. Try taking it again.");
    }
  }

  /** SRC-12: ready for the next garment. The cost usually stays the same. */
  function nextItem() {
    setPhoto(null);
    if (fileRef.current) fileRef.current.value = "";
    setBarcode("");
    setKeyword("");
    setBrand("");
    setSize("");
    appraise.reset();
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
    <div className={embedded ? "space-y-6" : "mx-auto w-full max-w-xl space-y-6 p-4 sm:p-6"}>
      <PageHeader icon={Sparkles} title="Buy decision" />

      {/* SRC-11: the how-to is body copy, not a subtitle. PageHeader drops its
          subtitle when embedded, which took the page's only instructions with
          it. */}
      <p className="text-sm text-muted-foreground">
        In the field, before you buy: snap the item (or scan its barcode), add
        what you'd pay, and get an instant <strong>buy / maybe / skip</strong>{" "}
        with condition, resale range, sell-through, and ROI.
      </p>

      {/* On a wide screen inside the host, the form sits beside the answer so
          the seller can change the cost and read the verdict without
          scrolling. */}
      <div className={embedded ? "grid gap-6 lg:grid-cols-2 lg:items-start" : "space-y-6"}>
        <div className="w-full max-w-xl space-y-6">
          {/* US-2851: the ceiling is quoted against this, so the seller has to be
              able to see and change it on the same screen that spends it. */}
          <SourcingTargetSetting />

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
                    onChange={(e) => void onPickPhoto(e)}
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
        </div>

        <div className="space-y-6">
          {appraise.isPending ? (
            <div className="h-48 w-full animate-pulse rounded-lg bg-muted" />
          ) : appraise.isError ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base text-destructive">Appraisal failed</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>{appraise.error.message}</p>
                {appraise.error.status === 402 || appraise.error.status === 429 ? (
                  <Button asChild size="sm">
                    <Link to="/dashboard/billing">See plans</Link>
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : result ? (
            <DecisionCard
              result={result}
              appraised={appraise.variables ?? {}}
              costCents={submittedCost}
              onNextItem={nextItem}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
