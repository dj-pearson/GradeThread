import { buildSrcSet } from "@/lib/images";

interface ImageProps {
  src: string;
  alt: string;
  /** Intrinsic/displayed width in px — reserves space (no CLS) + 1x srcset base. */
  width: number;
  /** Intrinsic/displayed height in px. */
  height: number;
  /**
   * Candidate widths for the srcset. Defaults to [width, width*2] (1x/2x DPR).
   * Pass a fuller ladder (e.g. [640, 1024, 1600]) for fluid-width images.
   */
  widths?: number[];
  /** `sizes` attribute. Defaults to `${width}px` (fixed-size image). */
  sizes?: string;
  /**
   * LCP / above-the-fold image → eager + fetchpriority=high. Everything else
   * lazy-loads. Defaults to false.
   */
  priority?: boolean;
  className?: string;
}

// Cloudflare Image Resizing only works when Transformations is enabled on the
// zone (a one-time dashboard toggle — see docs/SEO_PERFORMANCE.md). When it's
// OFF, every `/cdn-cgi/image/...` URL 404s, and because a failed `srcset`
// candidate does NOT fall back to `src`, the image renders broken. So we gate
// the srcset behind an explicit build flag: only emit it once the infra is
// confirmed on (VITE_CF_IMAGE_RESIZING="true"). Off → ship the plain original,
// which always 200s (just unoptimized). width/height are kept either way (CLS).
const CF_IMAGE_RESIZING_ENABLED =
  import.meta.env.VITE_CF_IMAGE_RESIZING === "true";

// Reusable responsive image (US-306). When resizing is enabled, emits a
// Cloudflare Image Resizing srcset (AVIF/WebP via format=auto) while keeping the
// original as the plain `src` fallback. Always carries width/height to prevent
// layout shift, and lazy-loads unless marked `priority`. Used across the public
// marketing/landing pages.
export function Image({
  src,
  alt,
  width,
  height,
  widths,
  sizes,
  priority = false,
  className,
}: ImageProps) {
  const candidateWidths = widths ?? [width, width * 2];
  const srcSet = CF_IMAGE_RESIZING_ENABLED
    ? buildSrcSet(src, candidateWidths) || undefined
    : undefined;
  return (
    <img
      src={src}
      srcSet={srcSet}
      // `sizes` is only meaningful alongside a `w`-descriptor srcset.
      sizes={srcSet ? (sizes ?? `${width}px`) : undefined}
      alt={alt}
      width={width}
      height={height}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
      className={className}
    />
  );
}
