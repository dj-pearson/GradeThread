import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isListingColumn, validateGridValue, type GridCol, type GridRow } from "./grid-columns";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staged: Map<string, Record<string, string>>;
  originals: Map<string, GridRow>;
  columns: GridCol[];
  saving: boolean;
  progress: number;
  onSave: () => void;
}

export function GridReview({ open, onOpenChange, staged, originals, columns, saving, progress, onSave }: Props) {
  let invalid = false;
  const changes = [...staged].flatMap(([id, edits]) => {
    const row = originals.get(id);
    if (!row) { invalid = true; return []; }
    const effectiveRow = { ...row, floor_price: "floor_price" in edits ? (edits.floor_price.trim() ? Number(edits.floor_price) : null) : row.floor_price };
    return Object.entries(edits).map(([field, after]) => {
      const col = columns.find(candidate => candidate.field === field);
      const error = col ? validateGridValue(col, after, effectiveRow) : "Column is no longer available.";
      if (error) invalid = true;
      return { id, row, field, col, after, error };
    });
  });
  const liveCount = new Set(changes.filter(change => change.col && isListingColumn(change.col) && change.row.listing?.listing_status === "active").map(change => change.id)).size;

  return <Dialog open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Review {changes.length} changes</DialogTitle>
        <DialogDescription>
          {liveCount ? `${liveCount} live eBay listing${liveCount === 1 ? "" : "s"} will be updated. ` : ""}
          Drafts stay unpublished. Inventory fields, including target price and inventory title, only change your inventory record.
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-[50dvh] space-y-3 overflow-y-auto">
        {changes.map(({ id, row, field, col, after, error }) => <div key={`${id}-${field}`} className="border-b pb-3 text-sm">
          <p className="font-medium">{row.item_title} / {col?.label ?? field}</p>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            <p className="break-words text-muted-foreground">Before: {col?.get(row) || "Empty"}</p>
            <p className="break-words">After: {after || "Empty"}</p>
          </div>
          {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
        </div>)}
      </div>
      {invalid && <p role="alert" className="text-sm text-destructive">Fix the marked values before saving.</p>}
      {saving && <p role="status" className="text-sm">Saving item {Math.min(progress + 1, staged.size)} of {staged.size}...</p>}
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Keep editing</Button>
        <Button onClick={onSave} disabled={saving || invalid || changes.length === 0}>{saving ? "Saving..." : liveCount ? "Save and update eBay" : "Save all"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
