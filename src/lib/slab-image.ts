// US-766: derive the Digital-Slab image URL (US-763) for a listing/item.
//
// The slab is the PSA-style, QR-bearing "graded photo" served at
// /slab/cert/:id (functions/slab/cert/[id].ts) from the PUBLIC certificate.
// An item's certificate_url is "<site>/cert/<id>"; its slab lives at the
// sibling "<site>/slab/cert/<id>". We rewrite the first "/cert/" segment so the
// origin is never hard-coded (this matches slabImageUrlForItem in the edge
// service's flipdesk-ebay.ts). Returns null when the item has no public
// certificate yet (the slab would render the transparent fallback).

import type { SlabImageMode } from "@/types/database";

/** Supported slab aspect-ratio formats (mirror SLAB_FORMATS in the slab Pages function). */
export type SlabFormat = "square" | "portrait" | "story" | "label";

export function slabImageUrl(
  certificateUrl: string | null | undefined,
  format: SlabFormat = "square",
): string | null {
  const cert = certificateUrl?.trim();
  if (!cert || !cert.includes("/cert/")) return null;
  const base = cert.replace("/cert/", "/slab/cert/");
  return `${base}${base.includes("?") ? "&" : "?"}format=${format}`;
}

/** Human-readable label for each slab attachment mode (composer + settings copy). */
export const SLAB_MODE_LABELS: Record<SlabImageMode, string> = {
  off: "Don't attach",
  hero: "Lead image",
  extra: "Supplementary image",
};
