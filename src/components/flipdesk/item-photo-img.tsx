// Drop-in replacement for a raw img element on item_photos rows (US-2273).
//
// Renders the resolved display URL from useItemPhotoDisplayUrl — which is a
// short-lived signed URL for iOS-captured private-bucket tags/certificates and
// the plain public/thumbnail URL for everything else. While a signed URL is
// being minted it shows a neutral pulse; if the mint FAILS it shows a labelled
// placeholder rather than a broken-image icon (AC4). Public photos resolve
// synchronously, so they render straight to an img element with no in-between.
//
// Wherever a surface previously wrote `<img src={itemPhotoThumb(photo)} … />`,
// use `<ItemPhotoImg photo={photo} … />` and pass the same className/alt/onClick.
//
// A URL THAT RESOLVES IS NOT A FILE THAT EXISTS. An item_photos row can outlive
// the object it points at — an upload that half-failed, a bucket cleaned up
// behind the row, a restore that brought the table back without the storage.
// The row then yields a perfectly good public URL that answers "Object not
// found", and until US-3186 this component handed that straight to an img and
// let the browser draw its broken-image glyph, with a console error per cell and
// nothing on screen saying which photo was gone. `onError` folds that into the
// SAME labelled placeholder a failed signed-URL mint already used, so a missing
// file looks like a missing file wherever it happens.

import { useEffect, useState } from "react";
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
  // Reset when the URL changes, so a re-signed or replaced photo gets a fresh
  // attempt rather than inheriting the previous one's failure.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);

  const label =
    PHOTO_TYPE_LABELS[photo.photo_type as keyof typeof PHOTO_TYPE_LABELS] ??
    "Photo";

  if (url && !broken) {
    return (
      <img
        src={url}
        alt={alt ?? label}
        className={className}
        onError={() => setBroken(true)}
        {...imgProps}
      />
    );
  }

  // Loading, un-mintable, or gone from storage: keep the same box so the layout
  // does not shift, and say which of those it is.
  const missing = failed || broken;
  return (
    <div
      role="img"
      aria-label={missing ? `${label} unavailable` : `${label} loading`}
      className={cn(
        "flex items-center justify-center bg-muted text-[10px] text-muted-foreground",
        loading && !missing && "animate-pulse",
        className,
      )}
    >
      {missing ? label : null}
    </div>
  );
}
