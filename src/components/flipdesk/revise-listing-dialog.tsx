import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
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
import type { ItemFullRow } from "@/types/database";

// Revises a live eBay listing's title / description / price / photo order in
// place via the Sell API. eBay blocks editing inventory-based listings on its
// own site ("refer to the tool used to create this listing"), so this dialog
// is the supported way to push edits — including a photo reorder with no text
// change. Reordering happens inline (PhotoManager) and the submit always
// re-syncs the current photo set to eBay.
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

  useEffect(() => {
    if (item) {
      setTitle(item.item_title ?? "");
      setDescription(item.item_description ?? "");
      setPrice(
        item.list_price != null ? String(item.list_price) : ""
      );
    }
  }, [item]);

  if (!item) return null;

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
            Pushes title, description, price, and photo order to eBay in place.
            eBay won't let you edit this listing on its own site, so this is the
            way to change it.
          </DialogDescription>
        </DialogHeader>
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
              Drag to reorder — the first photo is the eBay main image. Changes
              save instantly and are pushed to eBay when you submit.
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
      </DialogContent>
    </Dialog>
  );
}
