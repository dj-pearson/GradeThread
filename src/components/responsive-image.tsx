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

// Reusable responsive image (US-306). Emits a Cloudflare Image Resizing srcset
// (AVIF/WebP via format=auto) while keeping the original as the plain `src`
// fallback, always carries width/height to prevent layout shift, and lazy-loads
// unless marked `priority`. Used across the public marketing/landing pages.
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
  const srcSet = buildSrcSet(src, candidateWidths);
  return (
    <img
      src={src}
      srcSet={srcSet || undefined}
      sizes={sizes ?? `${width}px`}
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
