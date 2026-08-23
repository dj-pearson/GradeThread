import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AUCTION_DURATION_LABELS,
  AUCTION_DURATIONS,
  LISTING_FORMAT_LABELS,
  LISTING_FORMATS,
} from "@/lib/constants";
import type {
  ListingFormat,
  ListingVariation,
  ListingVariations,
} from "@/types/database";

// US-568: the composer's format + auction + variation editor state. Prices are
// kept as plain dollar strings (the composer converts to cents on save).
export interface ListingFormatValue {
  format: ListingFormat;
  auctionStartPrice: string;
  auctionReservePrice: string;
  auctionBuyItNowPrice: string;
  auctionDuration: string;
  variations: ListingVariations | null;
}

interface Props {
  value: ListingFormatValue;
  onChange: (next: ListingFormatValue) => void;
}

// The varies-by specs a clothing seller actually uses. Multi-variant eBay
// listings need at least one; Size + Color cover the overwhelming majority.
const SPEC_OPTIONS = ["Size", "Color"] as const;

// US-568: format + auction terms + multi-variant matrix. Auction and variations
// are mutually exclusive (eBay does not support multi-variation auctions), so
// enabling one disables the other.
export function ListingFormatControls({ value, onChange }: Props) {
  const variationsOn = value.variations !== null;

  function setFormat(format: ListingFormat) {
    onChange({
      ...value,
      format,
      // Auctions can't have variations.
      variations: format === "auction" ? null : value.variations,
    });
  }

  function toggleVariations(on: boolean) {
    onChange({
      ...value,
      // Variations force fixed-price.
      format: on ? "fixed_price" : value.format,
      variations: on
        ? { specifications: ["Size"], variants: [emptyVariant(["Size"])] }
        : null,
    });
  }

  function updateVariations(next: ListingVariations) {
    onChange({ ...value, variations: next });
  }

  // US-2335: ids for the two labelled selects below.
  const formatId = useId();
  const durationId = useId();

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium" htmlFor={formatId}>Listing format</Label>
        <Select
          value={value.format}
          onValueChange={(v) => setFormat(v as ListingFormat)}
          disabled={variationsOn}
        >
          <SelectTrigger className="h-9 w-full max-w-xs" id={formatId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LISTING_FORMATS.map((f) => (
              <SelectItem key={f} value={f}>
                {LISTING_FORMAT_LABELS[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {variationsOn && (
          <p className="text-xs text-muted-foreground">
            Multi-variant listings are always fixed price.
          </p>
        )}
      </div>

      {value.format === "auction" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="lfc-starting-bid" className="text-xs">Starting bid ($)</Label>
            <Input id="lfc-starting-bid"
              type="number"
              min="0"
              step="0.01"
              placeholder="Required"
              value={value.auctionStartPrice}
              onChange={(e) =>
                onChange({ ...value, auctionStartPrice: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={durationId}>Duration</Label>
            <Select
              value={value.auctionDuration}
              onValueChange={(v) => onChange({ ...value, auctionDuration: v })}
            >
              <SelectTrigger className="h-9" id={durationId}>
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
          <div className="space-y-1">
            <Label htmlFor="lfc-reserve-price-optional" className="text-xs">Reserve price ($, optional)</Label>
            <Input id="lfc-reserve-price-optional"
              type="number"
              min="0"
              step="0.01"
              placeholder="No reserve"
              value={value.auctionReservePrice}
              onChange={(e) =>
                onChange({ ...value, auctionReservePrice: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lfc-buy-it-now-optional" className="text-xs">Buy It Now ($, optional)</Label>
            <Input id="lfc-buy-it-now-optional"
              type="number"
              min="0"
              step="0.01"
              placeholder="None"
              value={value.auctionBuyItNowPrice}
              onChange={(e) =>
                onChange({ ...value, auctionBuyItNowPrice: e.target.value })
              }
            />
          </div>
        </div>
      )}

      <div className="space-y-2 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={variationsOn}
            onChange={(e) => toggleVariations(e.target.checked)}
          />
          Multi-variant listing (sizes / colors)
        </label>
        {variationsOn && value.variations && (
          <VariationEditor
            variations={value.variations}
            onChange={updateVariations}
          />
        )}
      </div>
    </div>
  );
}

function emptyVariant(specs: string[]): ListingVariation {
  const aspects: Record<string, string> = {};
  for (const s of specs) aspects[s] = "";
  return { aspects, quantity: 1, price_cents: null, sku_suffix: null };
}

function VariationEditor({
  variations,
  onChange,
}: {
  variations: ListingVariations;
  onChange: (next: ListingVariations) => void;
}) {
  const { specifications, variants } = variations;

  function toggleSpec(spec: string, on: boolean) {
    const nextSpecs = on
      ? [...specifications, spec]
      : specifications.filter((s) => s !== spec);
    // Keep at least one spec.
    if (nextSpecs.length === 0) return;
    const nextVariants = variants.map((v) => {
      const aspects: Record<string, string> = {};
      for (const s of nextSpecs) aspects[s] = v.aspects?.[s] ?? "";
      return { ...v, aspects };
    });
    onChange({ specifications: nextSpecs, variants: nextVariants });
  }

  function updateVariant(idx: number, patch: Partial<ListingVariation>) {
    const next = variants.map((v, i) => (i === idx ? { ...v, ...patch } : v));
    onChange({ specifications, variants: next });
  }

  function setVariantAspect(idx: number, spec: string, val: string) {
    const next = variants.map((v, i) =>
      i === idx ? { ...v, aspects: { ...v.aspects, [spec]: val } } : v,
    );
    onChange({ specifications, variants: next });
  }

  function addVariant() {
    onChange({
      specifications,
      variants: [...variants, emptyVariant(specifications)],
    });
  }

  function removeVariant(idx: number) {
    if (variants.length <= 1) return;
    onChange({ specifications, variants: variants.filter((_, i) => i !== idx) });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {SPEC_OPTIONS.map((spec) => (
          <label key={spec} className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={specifications.includes(spec)}
              onChange={(e) => toggleSpec(spec, e.target.checked)}
            />
            Varies by {spec}
          </label>
        ))}
      </div>

      <div className="space-y-2">
        {variants.map((variant, idx) => (
          <div
            key={idx}
            className="flex flex-wrap items-end gap-2 rounded-md border border-border/60 p-2"
          >
            {specifications.map((spec) => (
              <div key={spec} className="space-y-1">
                <Label className="text-[10px] uppercase text-muted-foreground">
                  {spec}
                </Label>
                {/* One id per (variant, spec) is impossible with a single
                    htmlFor: the same spec repeats once per variant, so one id
                    would point every label at the first row. Named by both
                    axes, which is what locates a grid cell anyway. */}
                <Input
                  aria-label={`${spec} for variant ${idx + 1}`}
                  className="h-8 w-24"
                  placeholder={spec}
                  value={variant.aspects?.[spec] ?? ""}
                  onChange={(e) => setVariantAspect(idx, spec, e.target.value)}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="lfc-qty" className="text-[10px] uppercase text-muted-foreground">
                Qty
              </Label>
              <Input id="lfc-qty"
                className="h-8 w-16"
                type="number"
                min="0"
                value={String(variant.quantity)}
                onChange={(e) =>
                  updateVariant(idx, {
                    quantity: Math.max(0, Number(e.target.value) || 0),
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lfc-price" className="text-[10px] uppercase text-muted-foreground">
                Price ($)
              </Label>
              <Input id="lfc-price"
                className="h-8 w-20"
                type="number"
                min="0"
                step="0.01"
                placeholder="Base"
                value={
                  variant.price_cents != null
                    ? String(variant.price_cents / 100)
                    : ""
                }
                onChange={(e) => {
                  const dollars = Number.parseFloat(e.target.value);
                  updateVariant(idx, {
                    price_cents:
                      Number.isFinite(dollars) && dollars > 0
                        ? Math.round(dollars * 100)
                        : null,
                  });
                }}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => removeVariant(idx)}
              disabled={variants.length <= 1}
              aria-label={`Remove variant ${idx + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        onClick={addVariant}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add variant
      </Button>
      <p className="text-xs text-muted-foreground">
        Need at least two in-stock variants to publish as one multi-variant
        listing.
      </p>
    </div>
  );
}
