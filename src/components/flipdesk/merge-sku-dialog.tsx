import { useEffect, useMemo, useState } from "react";
import { Loader2, Merge } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { ItemStatus, ItemComp } from "@/types/database";
import type { MergeValues } from "@/lib/merge-values";

// Re-exported so the dialog stays the one-stop import for merge consumers; the
// shape + row mapper live in @/lib/merge-values (see rowToMergeValues there).
export type { MergeValues } from "@/lib/merge-values";

type FieldKey = keyof MergeValues;

const FIELD_DEFS: { key: FieldKey; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "container", label: "Container" },
  { key: "brand", label: "Brand" },
  { key: "style", label: "Style" },
  { key: "size", label: "Size" },
  { key: "color", label: "Color" },
  { key: "material", label: "Material" },
  { key: "item_category", label: "Category" },
  { key: "status", label: "Status" },
  { key: "sourced_by", label: "Sourced by" },
  { key: "acquired_date", label: "Purchase date" },
  { key: "acquired_price", label: "Purchase price" },
  { key: "target_price", label: "Target price" },
  { key: "description", label: "Description" },
  { key: "condition_notes", label: "Internal notes" },
  { key: "measurements", label: "Measurements" },
  { key: "comp_set", label: "Comps" },
];

function isEmpty(v: MergeValues[FieldKey]): boolean {
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return Object.keys(v ?? {}).length === 0;
}

function isEqual(a: MergeValues[FieldKey], b: MergeValues[FieldKey]): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a.trim() === b.trim();
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function display(key: FieldKey, v: MergeValues[FieldKey]): string {
  if (isEmpty(v)) return "(empty)";
  if (key === "status") return ITEM_STATUS_LABELS[v as ItemStatus] ?? String(v);
  if (key === "measurements") {
    const m = v as Record<string, number | string>;
    const keys = Object.keys(m);
    return `${keys.length} measurement${keys.length === 1 ? "" : "s"} (${keys
      .slice(0, 4)
      .join(", ")}${keys.length > 4 ? ", …" : ""})`;
  }
  if (key === "comp_set") {
    const comps = v as ItemComp[];
    return `${comps.length} comp${comps.length === 1 ? "" : "s"}`;
  }
  if (key === "acquired_price" || key === "target_price") {
    return `$${String(v).trim()}`;
  }
  return String(v).trim();
}

interface ConflictRow {
  key: FieldKey;
  label: string;
  current: MergeValues[FieldKey];
  existing: MergeValues[FieldKey];
  // True when both sides have a value (a real conflict the user should weigh
  // in on); false when only the existing record has one (a gap-fill).
  bothFilled: boolean;
}

interface Props {
  open: boolean;
  sku: string;
  // Values from the item being edited — the record that survives the merge.
  current: MergeValues;
  // Values from the record that already owns the SKU — absorbed and deleted.
  existing: MergeValues;
  merging: boolean;
  onCancel: () => void;
  // Receives only the fields where the user chose to keep the existing
  // record's value; everything else keeps the current item's value.
  onConfirm: (overrides: Partial<MergeValues>) => void;
}

// Shown when saving an item with a SKU that another inventory record already
// uses. Lets the user combine the two records: photos, listings, sales and
// grading history are merged automatically; conflicting fields are resolved
// here, defaulting to the item being edited (assumed most up to date).
export function MergeSkuDialog({
  open,
  sku,
  current,
  existing,
  merging,
  onCancel,
  onConfirm,
}: Props) {
  const rows = useMemo<ConflictRow[]>(() => {
    const out: ConflictRow[] = [];
    for (const def of FIELD_DEFS) {
      const cur = current[def.key];
      const ex = existing[def.key];
      // Nothing to take from the existing record, or values already match —
      // the surviving item's value stands either way.
      if (isEmpty(ex) || isEqual(cur, ex)) continue;
      out.push({
        key: def.key,
        label: def.label,
        current: cur,
        existing: ex,
        bothFilled: !isEmpty(cur),
      });
    }
    return out;
  }, [current, existing]);

  const [choices, setChoices] = useState<Record<string, "current" | "existing">>(
    {},
  );

  // Defaults: real conflicts keep this item's value (most recent edit);
  // fields this item left blank are filled from the existing record.
  useEffect(() => {
    if (!open) return;
    const next: Record<string, "current" | "existing"> = {};
    for (const r of rows) next[r.key] = r.bothFilled ? "current" : "existing";
    setChoices(next);
  }, [open, rows]);

  function confirm() {
    const overrides: Partial<MergeValues> = {};
    for (const r of rows) {
      if (choices[r.key] === "existing") {
        (overrides as Record<string, unknown>)[r.key] = r.existing;
      }
    }
    onConfirm(overrides);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !merging && onCancel()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="h-5 w-5 text-primary" />
            SKU {sku} already exists — merge records?
          </DialogTitle>
          <DialogDescription>
            Another inventory record already uses this SKU. Merging combines
            both into this item: photos, listings, sales and grading history
            are kept from both, then the other record is removed. Pick which
            value to keep where they differ — this item&apos;s values are
            selected by default.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {rows.length === 0 ? (
            <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
              No conflicting fields — the records can be merged as-is.
            </p>
          ) : (
            rows.map((r) => (
              <div key={r.key} className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {r.label}
                  {!r.bothFilled && (
                    <span className="ml-1.5 font-normal normal-case tracking-normal">
                      (only on the existing record)
                    </span>
                  )}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ChoiceCard
                    heading="This item"
                    value={display(r.key, r.current)}
                    selected={choices[r.key] === "current"}
                    disabled={merging}
                    onSelect={() =>
                      setChoices((c) => ({ ...c, [r.key]: "current" }))
                    }
                  />
                  <ChoiceCard
                    heading="Existing record"
                    value={display(r.key, r.existing)}
                    selected={choices[r.key] === "existing"}
                    disabled={merging}
                    onSelect={() =>
                      setChoices((c) => ({ ...c, [r.key]: "existing" }))
                    }
                  />
                </div>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={merging}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={merging}>
            {merging ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Merge className="mr-2 h-4 w-4" />
            )}
            Merge into one item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChoiceCard({
  heading,
  value,
  selected,
  disabled,
  onSelect,
}: {
  heading: string;
  value: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "rounded-md border p-2.5 text-left text-sm transition-colors",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border hover:bg-muted/50",
        disabled && "opacity-60",
      )}
    >
      <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </span>
      <span
        className={cn(
          "mt-0.5 block wrap-break-word",
          value === "(empty)" && "italic text-muted-foreground",
        )}
      >
        {value}
      </span>
    </button>
  );
}
