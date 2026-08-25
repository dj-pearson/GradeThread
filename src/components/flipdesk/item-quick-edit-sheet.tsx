import { useEffect, useState } from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { ITEM_STATUSES, ITEM_STATUS_LABELS } from "@/lib/constants";
import type { ItemFullRow, ItemStatus } from "@/types/database";

// US-961: lightweight per-card quick-edit for the mobile listings card view.
// Edits the four fields a reseller most often tweaks on the go — title, price
// (the inventory item's target/asking price), status, and internal notes —
// straight on the base `inventory_items` table (same columns the full canvas
// persist() writes), then invalidates items_full so every surface refreshes.
// Intentionally NOT an eBay-syncing edit: the heavy revise-on-eBay flow lives
// in the full detail dialog; this is the fast local touch-up.
export function ItemQuickEditSheet({
  item,
  onClose,
}: {
  item: ItemFullRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [status, setStatus] = useState<ItemStatus>("sourced");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!item) return;
    setTitle(item.item_title ?? "");
    const p = item.target_price ?? item.list_price;
    setPrice(p == null ? "" : String(p));
    setStatus(item.status);
    setNotes(item.notes ?? "");
  }, [item]);

  async function save() {
    if (!item) return;
    const priceNum = price.trim() === "" ? null : Number(price);
    if (priceNum != null && (!Number.isFinite(priceNum) || priceNum < 0)) {
      toast.error("Enter a valid price.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("inventory_items")
        .update({
          title: title.trim() || item.item_title,
          target_price: priceNum,
          condition_notes: notes.trim() || null,
          status,
        } as never)
        .eq("id", item.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Saved.");
      onClose();
    } catch (err) {
      toastError(err, "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="max-h-[88dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Quick edit</SheetTitle>
          <SheetDescription>
            {item?.item_number ? `SKU ${item.item_number}` : "Edit item details"}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <div className="space-y-1.5">
            <Label htmlFor="quick-edit-title">Title</Label>
            <Input
              id="quick-edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Item title"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quick-edit-price">Price</Label>
            <Input
              id="quick-edit-price"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quick-edit-status">Status</Label>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as ItemStatus)}
            >
              <SelectTrigger id="quick-edit-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ITEM_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {ITEM_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quick-edit-notes">Notes</Label>
            <Textarea
              id="quick-edit-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal notes"
              rows={3}
            />
          </div>
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
