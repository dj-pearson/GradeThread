import { useEffect, useState } from "react";
import {
  Heart,
  ImageOff,
  Monitor,
  RotateCcw,
  Smartphone,
  Truck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { itemPhotoThumb } from "@/lib/images";
import { splitSellerCredentials } from "@/lib/listing-templates";
import type { ItemPhotoRow } from "@/types/database";

export type PreviewViewport = "desktop" | "mobile";

export interface EbayViewItemPreviewProps {
  title: string;
  /** Resolved sale price, or null when the seller hasn't set one yet. */
  price: number | null;
  /** Photos in display order — the first acts as the eBay gallery default. */
  photos: ItemPhotoRow[];
  /** Which photo the composer has marked primary (seeds the gallery). */
  primaryPhotoId: string | null;
  /** eBay condition label, already mapped from the condition enum. */
  conditionLabel: string;
  /** Two-column "Item specifics" rows (already filtered to non-empty). */
  specifics: { label: string; value: string }[];
  /**
   * Resolved (template-interpolated) description. The plain body is rendered as
   * escaped text; the trailing GradeThread seller-credentials block (behind its
   * HTML marker) is rendered as HTML, matching how eBay renders the description.
   */
  description: string;
  /** Flat shipping charge; 0 / null renders as "Free". */
  shippingCost: number | null;
  /** Assigned fulfillment (shipping) business-policy name, if any. */
  shippingPolicyName: string | null;
  /** Assigned return business-policy name, if any. */
  returnPolicyName: string | null;
  /** Renders the GradeThread Verified badge over the hero photo. */
  showBadge: boolean;
  /** Numeric grade for the badge (only used when showBadge). */
  gradeValue: number | null;
}

// Renders an approximation of eBay's real view-item page — gallery, condition
// pill, price box, specifics table, and the shipping/returns lines driven by
// the assigned business policy — so the composer preview matches what buyers
// actually see (US-558). A desktop/mobile toggle swaps the layout the same way
// eBay's responsive page does.
export function EbayViewItemPreview(props: EbayViewItemPreviewProps) {
  const {
    title,
    price,
    photos,
    primaryPhotoId,
    conditionLabel,
    specifics,
    description,
    shippingCost,
    shippingPolicyName,
    returnPolicyName,
    showBadge,
    gradeValue,
  } = props;

  const [viewport, setViewport] = useState<PreviewViewport>("desktop");
  const [activeId, setActiveId] = useState<string | null>(primaryPhotoId);

  // Keep the gallery's active photo in sync when the composer's primary
  // changes or the active one is removed from the order.
  useEffect(() => {
    const stillPresent = photos.some((p) => p.id === activeId);
    if (!stillPresent) setActiveId(primaryPhotoId ?? photos[0]?.id ?? null);
  }, [photos, activeId, primaryPhotoId]);

  const heroFromActive =
    photos.find((p) => p.id === activeId) ??
    photos.find((p) => p.id === primaryPhotoId) ??
    photos[0] ??
    null;

  const priceLabel = price != null ? `US $${price.toFixed(2)}` : "Price not set";
  const shipLabel =
    shippingCost == null || shippingCost <= 0
      ? "Free shipping"
      : `US $${shippingCost.toFixed(2)} shipping`;
  const isMobile = viewport === "mobile";

  const hero = (
    <div className="relative aspect-square w-full overflow-hidden rounded-lg border bg-muted/40">
      {heroFromActive ? (
        <img
          src={heroFromActive.photo_url}
          alt={title || "Listing photo"}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
          <ImageOff className="h-6 w-6" />
          <span className="text-xs">No photo selected</span>
        </div>
      )}
      {showBadge && heroFromActive && gradeValue != null && (
        <div className="absolute bottom-2 right-2 flex overflow-hidden rounded-md bg-brand-navy text-white shadow-lg">
          <div className="w-1.5 bg-brand-red" />
          <div className="px-2.5 py-1.5 leading-tight">
            <div className="text-[8px] font-bold tracking-wider">
              GRADETHREAD VERIFIED
            </div>
            <div className="text-base font-bold">
              {gradeValue.toFixed(1)} / 10
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const thumbs =
    photos.length > 1 ? (
      <div
        className={cn(
          "gap-1.5",
          isMobile
            ? "flex overflow-x-auto pb-1"
            : "flex flex-row flex-wrap content-start sm:flex-col sm:flex-nowrap",
        )}
      >
        {photos.map((photo) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => setActiveId(photo.id)}
            className={cn(
              "h-12 w-12 flex-shrink-0 overflow-hidden rounded border bg-muted/40",
              photo.id === heroFromActive?.id
                ? "ring-2 ring-brand-navy"
                : "hover:ring-1 hover:ring-muted-foreground/40",
            )}
          >
            <img
              src={itemPhotoThumb(photo, 96)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </button>
        ))}
      </div>
    ) : null;

  // The right-hand "buy box": title, condition pill, price, faux CTAs, and the
  // policy-driven shipping/returns lines.
  const buyBox = (
    <div className="space-y-3">
      <h2 className="text-base font-medium leading-snug">
        {title || <span className="text-muted-foreground">Untitled listing</span>}
      </h2>

      <div className="flex items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-brand-navy/30 bg-brand-navy/5 px-2.5 py-0.5 text-xs font-medium text-brand-navy dark:text-foreground">
          {conditionLabel}
        </span>
      </div>

      <div className="border-y py-3">
        <div className="text-2xl font-bold">{priceLabel}</div>
      </div>

      <div className="space-y-2">
        <div className="rounded-full bg-[#3665f3] px-4 py-2 text-center text-sm font-semibold text-white">
          Buy It Now
        </div>
        <div className="rounded-full border border-[#3665f3] px-4 py-2 text-center text-sm font-semibold text-[#3665f3]">
          Add to cart
        </div>
        <div className="flex items-center justify-center gap-1.5 rounded-full border px-4 py-2 text-center text-sm font-semibold">
          <Heart className="h-4 w-4" /> Add to watchlist
        </div>
      </div>

      <dl className="space-y-2 pt-1 text-xs">
        <div className="flex gap-2">
          <dt className="flex-shrink-0 text-muted-foreground">
            <Truck className="h-4 w-4" />
          </dt>
          <dd>
            <span className="font-medium">{shipLabel}</span>
            {shippingPolicyName && (
              <span className="text-muted-foreground">
                {" "}
                · {shippingPolicyName}
              </span>
            )}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="flex-shrink-0 text-muted-foreground">
            <RotateCcw className="h-4 w-4" />
          </dt>
          <dd>
            <span className="font-medium">
              {returnPolicyName ?? "Returns per seller policy"}
            </span>
            {returnPolicyName && (
              <span className="text-muted-foreground"> · Returns accepted</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );

  const specificsTable =
    specifics.length > 0 ? (
      <div>
        <div className="mb-2 text-sm font-semibold">Item specifics</div>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-0 sm:grid-cols-2">
          {specifics.map((s) => (
            <div
              key={s.label}
              className="flex justify-between gap-2 border-b py-1.5 text-xs last:border-b-0"
            >
              <dt className="text-muted-foreground">{s.label}</dt>
              <dd className="text-right font-medium">{s.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    ) : null;

  // Peel the trailing GradeThread seller-credentials block off the body: the
  // body stays escaped text, the block renders as HTML (as eBay renders it).
  // The block is GradeThread-built markup with all dynamic values escaped at the
  // source (edge seller-credentials.ts), so rendering it here is safe.
  const { body: descriptionBody, credentials } = splitSellerCredentials(description);
  const credentialsHtml = credentials
    .replace("<!--gradethread-seller-credentials-->", "")
    .trim();

  const descriptionBlock = (
    <div>
      <div className="mb-2 text-sm font-semibold">Description</div>
      {description.trim() ? (
        <div className="rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
          {descriptionBody.trim() && (
            <p className="whitespace-pre-wrap">{descriptionBody}</p>
          )}
          {credentialsHtml && (
            <div
              className={cn(descriptionBody.trim() && "mt-3")}
              dangerouslySetInnerHTML={{ __html: credentialsHtml }}
            />
          )}
        </div>
      ) : (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Apply a template or write a description to preview it here.
        </p>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Desktop / mobile viewport toggle */}
      <div className="flex justify-end">
        <div className="inline-flex rounded-md border p-0.5">
          <button
            type="button"
            onClick={() => setViewport("desktop")}
            aria-pressed={!isMobile}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium",
              !isMobile
                ? "bg-brand-navy text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Monitor className="h-3.5 w-3.5" /> Desktop
          </button>
          <button
            type="button"
            onClick={() => setViewport("mobile")}
            aria-pressed={isMobile}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium",
              isMobile
                ? "bg-brand-navy text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Smartphone className="h-3.5 w-3.5" /> Mobile
          </button>
        </div>
      </div>

      <div
        className={cn(
          "mx-auto rounded-lg border bg-background p-4",
          isMobile ? "max-w-[22rem]" : "w-full",
        )}
      >
        {isMobile ? (
          // eBay mobile: single column — hero, thumb strip, then buy box.
          <div className="space-y-4">
            {hero}
            {thumbs}
            {buyBox}
            {specificsTable}
            {descriptionBlock}
          </div>
        ) : (
          // eBay desktop: thumbnail rail + hero on the left, buy box on the
          // right, specifics + description full-width below.
          <div className="space-y-6">
            <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="flex gap-3">
                {thumbs}
                <div className="min-w-0 flex-1">{hero}</div>
              </div>
              {buyBox}
            </div>
            {specificsTable}
            {descriptionBlock}
          </div>
        )}
      </div>
    </div>
  );
}
