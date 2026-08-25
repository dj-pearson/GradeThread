import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Loader2, Rocket } from "lucide-react";
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
import { supabase } from "@/lib/supabase";
import { advanceItemStatus } from "@/lib/status-writer";
import { safeHref } from "@/lib/safe-url";
import { todayLocalDate } from "@/lib/local-date";
import type { ItemFullRow, ListingInsert } from "@/types/database";

// Quick "this is live on eBay now" action — the manual bridge until the
// eBay API push (US-121) is wired.
export function MarkListedDialog({
  item,
  onClose,
}: {
  item: ItemFullRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(todayLocalDate());
  const [saving, setSaving] = useState(false);
  // Synchronous double-submit guard: `disabled={saving}` only takes effect on
  // the next render, so a fast double-click can fire save() twice and insert two
  // listing rows. Flip this ref synchronously, before any await.
  const savingRef = useRef(false);

  useEffect(() => {
    if (item) {
      setUrl(item.link ?? "");
      setPrice(
        String(item.list_price ?? item.target_price ?? ""),
      );
      setDate(todayLocalDate());
    }
  }, [item]);

  if (!item) return null;

  async function save() {
    if (!item) return;
    if (savingRef.current) return;
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) {
      toast.error("Enter a valid list price.");
      return;
    }
    const trimmedUrl = url.trim();
    if (trimmedUrl && !safeHref(trimmedUrl)) {
      toast.error("Enter a valid listing URL (http:// or https://).");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const payload: ListingInsert = {
        inventory_item_id: item.id,
        platform: "ebay",
        listing_status: "active",
        listing_price: p,
        listing_url: url.trim() || null,
        listed_at: date || undefined,
        is_active: true,
      };
      // Update the existing listing row if one exists, else insert.
      if (item.listing_id) {
        const { error } = await supabase
          .from("listings")
          .update(payload as never)
          .eq("id", item.listing_id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("listings")
          // US-1077: manually marked listed through GradeThread → GradeThread-originated.
          .insert({ ...payload, listing_origin: "gradethread" } as never);
        if (error) throw error;
      }
      await advanceItemStatus(item.id, item.status, "listed");

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(`"${item.item_title}" marked as listed.`);
      onClose();
    } catch (err) {
      toastError(err, "Failed.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Mark as listed</DialogTitle>
          <DialogDescription>
            Record that "{item.item_title}" is live on eBay.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="mark-listed-price">List price</Label>
            <Input
              id="mark-listed-price"
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mark-listed-url">Listing URL</Label>
            <Input
              id="mark-listed-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.ebay.com/itm/…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mark-listed-date">Listed date</Label>
            <Input
              id="mark-listed-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
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
              <Rocket className="mr-2 h-4 w-4" />
            )}
            Mark listed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
