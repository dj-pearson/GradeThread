import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Loader2, Save } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PhotoManager } from "@/components/flipdesk/photo-manager";
import { useEbayReviseListing } from "@/hooks/use-ebay";
import { supabase } from "@/lib/supabase";
import type { ItemFullRow } from "@/types/database";

// Revises a live eBay listing's title / description / price / photo order in
// place via the Sell API. eBay blocks editing inventory-based listings on its
// own site ("refer to the tool used to create this listing"), so this dialog
// is the supported way to push edits — including a photo reorder with no text
// change. Reordering happens inline (PhotoManager) and the submit always
// re-syncs the current photo set to eBay.
//
// ORIGIN BRANCH: only GradeThread-PUBLISHED listings (those with a Sell API
// `platform_offer_id`) can be revised in place. eBay-NATIVE listings (created
// on eBay / Seller Hub, pulled in by sync) have no offer, so the Sell API can't
// touch them — but eBay DOES allow editing those on its own site. For those we
// show an "Edit on eBay" deep link instead of a form that would 409.
export function ReviseListingDialog({
  item,
  onClose,
}: {
  item: ItemFullRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const revise = useEbayReviseListing();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");

  // Resolve the listing's origin: a non-null platform_offer_id means GradeThread
  // published it via the Sell API and we can revise it in place. listing_url is
  // the eBay deep link used for the native-listing fallback.
  const listingId = item?.listing_id ?? null;
  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: ["listing_origin", listingId],
    enabled: !!listingId,
    queryFn: async (): Promise<{
      platform_offer_id: string | null;
      listing_url: string | null;
    }> => {
      const { data, error } = await supabase
        .from("listings")
        .select("platform_offer_id, listing_url")
        .eq("id", listingId as string)
        .maybeSingle();
      if (error) throw error;
      return (data ?? { platform_offer_id: null, listing_url: null }) as {
        platform_offer_id: string | null;
        listing_url: string | null;
      };
    },
  });

  useEffect(() => {
    if (item) {
      setTitle(item.item_title ?? "");
      setDescription(item.item_description ?? "");
      setPrice(item.list_price != null ? String(item.list_price) : "");
    }
  }, [item]);

  if (!item) return null;

  const gradeThreadPublished = !!meta?.platform_offer_id;
  const ebayUrl = meta?.listing_url ?? item.link ?? null;

  async function save() {
    if (!item || !item.listing_id) {
      toast.error("No listing record to revise.");
      return;
    }

    const patch: {
      title?: string;
      description?: string;
      listing_price?: number;
      photos?: boolean;
    } = {
      // Always re-sync the current photo set + order to eBay on submit. This is
      // what makes a photo-only reorder reach the live listing (the server
      // re-PUTs the inventory_item), and it's harmless when photos are
      // unchanged.
      photos: true,
    };
    const trimmedTitle = title.trim();
    const trimmedDesc = description.trim();
    const numericPrice = Number(price);

    if (trimmedTitle && trimmedTitle !== (item.item_title ?? "").trim()) {
      patch.title = trimmedTitle;
    }
    if (trimmedDesc !== (item.item_description ?? "").trim()) {
      patch.description = trimmedDesc;
    }
    if (
      Number.isFinite(numericPrice) &&
      numericPrice > 0 &&
      numericPrice !== item.list_price
    ) {
      patch.listing_price = numericPrice;
    }

    const fieldCount = Object.keys(patch).filter((k) => k !== "photos").length;

    try {
      await revise.mutateAsync({ listingId: item.listing_id, patch });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(
        fieldCount > 0
          ? `Listing updated on eBay (${fieldCount} field${
              fieldCount === 1 ? "" : "s"
            } + photo order).`
          : "Photo order synced to eBay.",
      );
      onClose();
    } catch (err) {
      const e = err as Error & { status?: number };
      // 409 → no offer_id; user needs to republish first. Surface clearly.
      if (e.status === 409) {
        toast.error(
          "Can't revise — this listing has no eBay offer id. Republish from Drafts first.",
          { duration: 12_000 },
        );
        return;
      }
      toast.error(`Revision failed: ${e.message}`);
    }
  }

  const saving = revise.isPending;
  const titleLen = title.trim().length;

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit live listing</DialogTitle>
          <DialogDescription>
            {metaLoading
              ? "Checking how this listing was created…"
              : gradeThreadPublished
                ? "Pushes title, description, price, and photo order to eBay in place. eBay won't let you edit this listing on its own site, so this is the way to change it."
                : "This listing was created on eBay, not GradeThread, so it can be edited directly on eBay."}
          </DialogDescription>
        </DialogHeader>

        {metaLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : !gradeThreadPublished ? (
          // eBay-NATIVE listing: no Sell offer to revise. eBay allows editing it
          // on its own site, so deep-link there instead of offering a form that
          // would fail. (Alternatively, relist it through GradeThread to manage
          // it here — that path is one click away via the relist action.)
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              GradeThread can only push edits to listings it published itself.
              This one originated on eBay, so open it on eBay to change the title,
              price, or description. To manage it from GradeThread instead, use
              <span className="font-medium"> Relist as a new listing</span> (the
              ↺ action) — that republishes it through GradeThread and unlocks
              in-app editing.
            </p>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              {ebayUrl ? (
                <Button asChild>
                  <a href={ebayUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Edit on eBay
                  </a>
                </Button>
              ) : (
                <Button disabled title="No eBay listing URL on record">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Edit on eBay
                </Button>
              )}
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-4">
              <div className="space-y-1">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="revise-title">Title</Label>
                  <span
                    className={
                      titleLen > 80
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {titleLen}/80
                  </span>
                </div>
                <Input
                  id="revise-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={80}
                  autoFocus
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="revise-description">Description</Label>
                <Textarea
                  id="revise-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={8}
                  placeholder="Buyers see this on the listing page."
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="revise-price">Price (USD)</Label>
                <Input
                  id="revise-price"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <Label>Photos</Label>
                <p className="text-xs text-muted-foreground">
                  Drag to reorder — the first photo is the eBay main image.
                  Changes save instantly and are pushed to eBay when you submit.
                </p>
                <PhotoManager itemId={item.id} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Push to eBay
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
