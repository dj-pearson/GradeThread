// Drop-in <img> replacement for item_photos rows (US-2273).
//
// Renders the resolved display URL from useItemPhotoDisplayUrl — which is a
// short-lived signed URL for iOS-captured private-bucket tags/certificates and
// the plain public/thumbnail URL for everything else. While a signed URL is
// being minted it shows a neutral pulse; if the mint FAILS it shows a labelled
// placeholder rather than a broken-image icon (AC4). Public photos resolve
// synchronously, so they render straight to an <img> with no intermediate state.
//
// Wherever a surface previously wrote `<img src={itemPhotoThumb(photo)} … />`,
// use `<ItemPhotoImg photo={photo} … />` and pass the same className/alt/onClick.

import type { ImgHTMLAttributes } from "react";
import { PHOTO_TYPE_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useItemPhotoDisplayUrl } from "@/hooks/use-item-photo-url";
import type { PhotoLike } from "@/lib/item-photo-url";

export interface ItemPhotoImgProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  photo: PhotoLike;
  /** Thumbnail render width for the public path (defaults to the grid width). */
  displayWidth?: number;
  /** Serve the original instead of a thumbnail (full-screen viewer / zoom). */
  full?: boolean;
}

export function ItemPhotoImg({
  photo,
  displayWidth,
  full,
  alt,
  className,
  ...imgProps
}: ItemPhotoImgProps) {
  const { url, loading, failed } = useItemPhotoDisplayUrl(photo, {
    width: displayWidth,
    full,
  });
  const label =
    PHOTO_TYPE_LABELS[photo.photo_type as keyof typeof PHOTO_TYPE_LABELS] ??
    "Photo";

  if (url) {
    return <img src={url} alt={alt ?? label} className={className} {...imgProps} />;
  }

  // Loading or failed: keep the same box so the layout does not shift.
  return (
    <div
      role="img"
      aria-label={failed ? `${label} unavailable` : `${label} loading`}
      className={cn(
        "flex items-center justify-center bg-muted text-[10px] text-muted-foreground",
        loading && "animate-pulse",
        className,
      )}
    >
      {failed ? label : null}
    </div>
  );
}
