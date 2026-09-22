import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
import {
  planBulkFields,
  type BulkFieldsForm,
  type BulkFieldsPatch,
} from "@/pages/flipdesk/bulk-fields";

const EMPTY: BulkFieldsForm = { bin: "", clearBin: false, brand: "", clearBrand: false };

// US-3467: set the bin or brand on every selected item at once, on any tab.
// These are GradeThread's own fields: a brand change here does not revise a
// live marketplace listing, which is why the dialog says so.
export function BulkFieldsDialog({
  open,
  count,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  count: number;
  onOpenChange: (open: boolean) => void;
  onApply: (patch: BulkFieldsPatch) => Promise<boolean>;
}) {
  const [form, setForm] = useState<BulkFieldsForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setForm(EMPTY);
  }, [open]);

  const patch = planBulkFields(form);
  const nothing = Object.keys(patch).length === 0;

  async function apply() {
    setSaving(true);
    try {
      if (await onApply(patch)) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Edit {count} item{count === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Fill in only what you want to change. Blank boxes leave each item as
            it is. This changes your inventory records, not live listings.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-fields-bin">Bin / location</Label>
            <Input
              id="bulk-fields-bin"
              value={form.bin}
              disabled={form.clearBin}
              onChange={(e) => setForm({ ...form, bin: e.target.value })}
              placeholder="e.g. A3"
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={form.clearBin}
                onChange={(e) => setForm({ ...form, clearBin: e.target.checked })}
                className="h-3.5 w-3.5"
              />
              Clear the bin on all of them
            </label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-fields-brand">Brand</Label>
            <Input
              id="bulk-fields-brand"
              value={form.brand}
              disabled={form.clearBrand}
              onChange={(e) => setForm({ ...form, brand: e.target.value })}
              placeholder="e.g. Patagonia"
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={form.clearBrand}
                onChange={(e) => setForm({ ...form, clearBrand: e.target.checked })}
                className="h-3.5 w-3.5"
              />
              Clear the brand on all of them
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={saving || nothing}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Apply to {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
