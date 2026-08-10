import { Link2 } from "lucide-react";
import { PhotoManager } from "@/components/flipdesk/photo-manager";
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import type { MutableRefObject } from "react";
import type { ItemFullRow, ItemPhotoRow } from "@/types/database";
export interface PhotosCardProps {
  /** Needed for the grade copy, category and certificate link. */
  item: ItemFullRow;
  /** Non-null only for a genuinely live listing — drives the eBay gallery re-sync. */
  liveListingId: string | null;
  primaryPhoto: ItemPhotoRow | null;
  setPrimaryPhotoId: (id: string | null) => void;
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
        {/* US-2465: `items_full` has no item_category column, so `item.category`
            is the free-text GARMENT word ("blazer", "dress pants") — which is
            exactly what picks the clothing sub-profile. Passing it as `garment`
            says so, instead of casting it to a type it has never held. */}
        <PhotoUploader
          itemId={item.id}
          currentStatus={item.status}
          category={null}
          garment={item.category}
        />
        <PhotoManager
          itemId={item.id}
          liveListingId={liveListingId}
          dirtyRef={photosDirtyRef}
          garment={item.category}
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
              (GradeThread)” item specific, plus the certificate number a
              buyer can type in to verify it. Your own photos are never
              altered — no watermarks or QR codes burned into them, which
              protects your marketplace account.
            </p>
            {/* US-2382: there is deliberately NO control here for adding a
                generated grade-card image to the gallery. US-2247 shipped
                one, and it wrote listings.badge_enabled / slab_image_mode
                that nothing read — a switch a seller could flip, save and
                publish with no card and no error. The fix is removal, not
                wiring: a grade card in the gallery is still a listing photo
                carrying a third-party grading mark, which is the exact
                thing the 2026-06-25 policy bans because a marketplace can
                suspend the account over it. The three text channels above
                carry the same information at zero risk. See
                vault/30-platform/grade-authority-on-listings.md before
                adding any image treatment back. */}
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