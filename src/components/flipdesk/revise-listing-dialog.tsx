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
import { useEbayReviseListing } from "@/hooks/use-ebay";
import type { ItemFullRow } from "@/types/database";

// Revises a live eBay listing's title / description / price in place via
// Sell API. Photos and aspects sync implicitly when the inventory_item is
// re-PUT server-side, so editing those through their own surfaces will also
// land on the next save here.
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
    } = {};
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

    if (Object.keys(patch).length === 0) {
      toast.info("No changes to push.");
      return;
    }

    try {
      await revise.mutateAsync({ listingId: item.listing_id, patch });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(
        `Listing updated on eBay (${Object.keys(patch).length} field${
          Object.keys(patch).length === 1 ? "" : "s"
        }).`,
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit live listing</DialogTitle>
          <DialogDescription>
            Pushes title, description, and price changes to eBay in place. Photos
            and category aspects sync from their own surfaces.
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
