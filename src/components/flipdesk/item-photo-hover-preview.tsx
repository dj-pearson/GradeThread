// Hover-to-enlarge for the small cover thumbnails in the Inventory table.
//
// The 40px cell thumbnail is too small to tell a stain from a shadow, and the
// only way to see the photo was to open the item. Hovering the thumbnail now
// floats a ~256px preview beside the row.
//
// COSTS NOTHING EXTRA TO OPEN: the preview asks ItemPhotoImg for the same
// display URL the thumbnail already resolved — the stored ~320w
// `thumbnail_url` (US-413), or the same cached signed URL for a private-bucket
// photo (US-2273) — so the bytes are already in the browser cache and the
// full-res original is never fetched. Do NOT switch this to `full`.
//
// The floating card is `pointer-events-none`: it is a preview, nothing in it is
// clickable, and passing clicks through means it can never swallow a click
// meant for the row underneath it.

import type { ReactNode } from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { ItemPhotoImg } from "@/components/flipdesk/item-photo-img";
import type { PhotoLike } from "@/lib/item-photo-url";

export interface ItemPhotoHoverPreviewProps {
  photo: PhotoLike;
  /** Row label, used as the caption and the enlarged image's alt text. */
  label?: string;
  /** The thumbnail to hover. Wrapped in the hover anchor as-is. */
  children: ReactNode;
}

export function ItemPhotoHoverPreview({
  photo,
  label,
  children,
}: ItemPhotoHoverPreviewProps) {
  return (
    <HoverCardPrimitive.Root openDelay={220} closeDelay={80}>
      {/* A span, not `asChild` on the image: the image renders a placeholder
          div while a signed URL is minting, and the anchor must survive that
          swap. */}
      <HoverCardPrimitive.Trigger asChild>
        <span className="inline-flex">{children}</span>
      </HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          className="pointer-events-none z-50 animate-in rounded-xl bg-popover p-2 shadow-xl fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <ItemPhotoImg
            photo={photo}
            displayWidth={320}
            alt={label ?? ""}
            className="h-64 w-64 rounded-lg bg-muted object-contain"
          />
          {label ? (
            <p className="mt-1.5 w-64 truncate text-xs text-popover-foreground/70">
              {label}
            </p>
          ) : null}
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}
