import { Link2 } from "lucide-react";
import { PhotoManager } from "@/components/flipdesk/photo-manager";
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import type { MutableRefObject } from "react";
import type { ItemCategory, ItemFullRow, ItemPhotoRow, SlabImageMode } from "@/types/database";
export interface PhotosCardProps {
  /** Needed for the grade copy, category and certificate link. */
  item: ItemFullRow;
  /** Non-null only for a genuinely live listing — drives the eBay gallery re-sync. */
  liveListingId: string | null;
  primaryPhoto: ItemPhotoRow | null;
  setPrimaryPhotoId: (id: string | null) => void;
  /** US-2247: add a generated grade-card image to the gallery. */
  badgeEnabled: boolean;
  setBadgeEnabled: (on: boolean) => void;
  slabImageMode: SlabImageMode;
  setSlabImageMode: (mode: SlabImageMode) => void;
  /** US-2381: the page owns the "photos changed this session" flag so its
   *  resubmit — which always sends `photos: true` — can clear it and stop
   *  PhotoManager's unmount auto-sync pushing the same gallery a second time.
   *  This coordination used to live on ItemCanvas, which no longer exists. */
  photosDirtyRef: MutableRefObject<boolean>;
}
// The full shared photo toolkit — upload, reorder, rotate/crop/straighten,
// retag, delete, background removal and click-to-view — identical to the item
// page, so the drafts flow never sends the seller elsewhere for photo work
// (US-1567). The star keeps the composer's primary-photo pick.
export function PhotosCard({
  item,
  liveListingId,
  primaryPhoto,
  setPrimaryPhotoId,
  badgeEnabled,
  setBadgeEnabled,
  slabImageMode,
  setSlabImageMode,
  photosDirtyRef,
}: PhotosCardProps) {
  return (
    <Card id="composer-photos">
      <CardHeader>
        <CardTitle>Photos</CardTitle>
        <CardDescription>
          Drag to reorder, click a photo to view it full size, and use
          the pencil to rotate, straighten, or crop. The star picks the
          primary image.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* US-1567: the full shared photo toolkit — upload, reorder,
            rotate/crop/straighten, retag, delete, background removal,
            and click-to-view — identical to the item page, so the
            drafts flow never sends the seller elsewhere for photo
            work. The star keeps the composer's primary-photo pick. */}
        <PhotoUploader
          itemId={item.id}
          currentStatus={item.status}
          category={item.category as ItemCategory | null}
        />
        <PhotoManager
          itemId={item.id}
          liveListingId={liveListingId}
          dirtyRef={photosDirtyRef}
          primaryPhotoId={primaryPhoto?.id ?? null}
          onPickPrimary={setPrimaryPhotoId}
        />

        {item.grade_value != null && (
          <div className="rounded-md border p-3">
            <p className="text-sm font-medium">
              Grade shown on this listing
            </p>
            <p className="text-xs text-muted-foreground">
              Graded items automatically add the grade to the description
              and a “Condition Grade: {item.grade_value.toFixed(1)}{" "}
              (GradeThread)” item specific, plus a link to the certificate
              page buyers can verify. Your own photos are never altered —
              no watermarks or QR codes burned into them, which protects
              your marketplace account.
            </p>
            {/* US-2247: publish has always read listings.badge_enabled and
                slab_image_mode, but nothing in the app wrote either — so
                the grade banner told sellers to "enable the grade badge
                below" and no such control existed anywhere. The grade card
                is a SEPARATE gallery image, not an overlay on the seller's
                own shots, which is why the copy above still holds. */}
            <div className="mt-3 space-y-2 rounded-md border bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Label htmlFor="grade-badge" className="text-sm">
                    Add a grade card image to the gallery
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    A generated image showing the {item.grade_value.toFixed(1)}
                    /10 grade and certificate link, added alongside your
                    photos.
                  </p>
                </div>
                <Switch
                  id="grade-badge"
                  checked={badgeEnabled}
                  onCheckedChange={(on) => {
                    setBadgeEnabled(on);
                    // Turning the card on with mode "off" would store a
                    // contradiction publish can't act on; seed a real mode.
                    if (on && slabImageMode === "off") {
                      setSlabImageMode("extra");
                    }
                    if (!on) setSlabImageMode("off");
                  }}
                  aria-label="Add a grade card image to this listing's gallery"
                />
              </div>
              {badgeEnabled && (
                <div className="space-y-1.5">
                  <Label htmlFor="slab-mode" className="text-xs">
                    Where it goes
                  </Label>
                  <Select
                    value={slabImageMode === "off" ? "extra" : slabImageMode}
                    onValueChange={(v) =>
                      setSlabImageMode(v as SlabImageMode)
                    }
                  >
                    <SelectTrigger id="slab-mode" className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="extra" className="text-xs">
                        Extra gallery image (after your photos)
                      </SelectItem>
                      <SelectItem value="hero" className="text-xs">
                        First image buyers see
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    “First image” maximises the grade's visibility in
                    search results; “extra” keeps your own hero shot.
                  </p>
                </div>
              )}
            </div>
            {/* US-1665 growth loop: one-click copy of the public
                certificate link, so a seller can paste the verifiable
                grade into ANY marketplace listing (not just eBay). Each
                shared link is an indexable inbound reference to the cert. */}
            {item.certificate_url && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  const certUrl = item.certificate_url;
                  if (!certUrl) return;
                  void navigator.clipboard
                    .writeText(certUrl)
                    .then(() =>
                      toast.success("Certificate link copied", {
                        description:
                          "Paste it into your listing so buyers can verify the grade.",
                      }),
                    )
                    .catch(() =>
                      toast.error("Couldn't copy the link"),
                    );
                }}
              >
                <Link2 className="mr-2 h-4 w-4" />
                Copy certificate link for your listing
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}