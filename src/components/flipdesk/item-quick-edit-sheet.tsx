import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, ExternalLink, Loader2 } from "lucide-react";
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
import { ITEM_STATUSES, ITEM_STATUS_LABELS, MARKETPLACE_LABELS } from "@/lib/constants";
import {
  formFromItem,
  planQuickEdit,
  type QuickEditForm,
} from "@/pages/flipdesk/quick-edit-plan";
import type { ItemFullRow, ItemStatus } from "@/types/database";

export interface QuickEditActions {
  patchItemColumns: (
    it: ItemFullRow,
    base: Record<string, string | number | null>,
    view: Partial<ItemFullRow>,
  ) => Promise<boolean>;
  updateItemStatus: (it: ItemFullRow, next: ItemStatus) => Promise<void>;
  updateListingPrice: (it: ItemFullRow, raw: string) => Promise<void>;
}

// US-961 made this a four-field sheet for the phone card list. US-3467 makes it
// the Inventory list's main editor on every screen: clicking a row opens it
// beside the list instead of leaving for the full composer, so a price, bin or
// status change no longer costs a page load and a trip back.
//
// Each field saves through the path the table's inline cells already use (see
// quick-edit-plan.ts for which is which), so the listed price still reaches the
// marketplace and a re-drafted status still pulls the listing back to draft.
//
// Up/Down (or J/K) steps to the neighbouring row on this page, saving first when
// something changed, so a seller can walk a shelf of items without closing the
// panel. Ctrl/Cmd+Enter saves.
export function ItemQuickEditSheet({
  item,
  items = [],
  onSelect,
  onClose,
  onOpenFull,
  actions,
}: {
  item: ItemFullRow | null;
  /** The rows on screen, in order. Up/Down steps through these. */
  items?: ItemFullRow[];
  onSelect?: (next: ItemFullRow) => void;
  onClose: () => void;
  onOpenFull?: (it: ItemFullRow) => void;
  actions: QuickEditActions;
}) {
  const [form, setForm] = useState<QuickEditForm | null>(null);
  const [saving, setSaving] = useState(false);
  // The form resets when the panel moves to another item, never when the same
  // item's row refreshes underneath it: a refetch mid-typing must not wipe
  // what the seller has typed.
  const loadedId = useRef<string | null>(null);
  useEffect(() => {
    if (!item) {
      loadedId.current = null;
      setForm(null);
      return;
    }
    if (loadedId.current === item.id) return;
    loadedId.current = item.id;
    setForm(formFromItem(item));
  }, [item]);

  const plan = useMemo(
    () => (item && form ? planQuickEdit(item, form) : null),
    [item, form],
  );

  const index = item ? items.findIndex((r) => r.id === item.id) : -1;
  const prev = index > 0 ? items[index - 1] : null;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null;

  function set<K extends keyof QuickEditForm>(key: K, value: QuickEditForm[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  /** Saves what changed. Resolves true when there is nothing left unsaved. */
  async function save(): Promise<boolean> {
    if (!item || !plan) return true;
    if (plan.errors.length > 0) {
      toast.error(plan.errors[0]);
      return false;
    }
    if (!plan.changed) return true;
    setSaving(true);
    try {
      const ok = await actions.patchItemColumns(item, plan.base, plan.view);
      if (!ok) return false;
      if (plan.status) await actions.updateItemStatus(item, plan.status);
      if (plan.listPrice != null) {
        await actions.updateListingPrice(item, String(plan.listPrice));
      }
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function go(target: ItemFullRow | null | undefined) {
    if (!target || !onSelect) return;
    if (await save()) onSelect(target);
  }

  async function saveAndClose() {
    if (await save()) onClose();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void saveAndClose();
      return;
    }
    const el = e.target as HTMLElement;
    const typing =
      el.closest("input, textarea, select, [role='combobox'], [role='listbox']") != null;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      void go(next);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      void go(prev);
    }
  }

  const live = item?.listing_status === "active";
  const platform = item?.listing_platform
    ? (MARKETPLACE_LABELS as Record<string, string>)[item.listing_platform] ?? item.listing_platform
    : null;

  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-md"
        onKeyDown={onKeyDown}
      >
        <SheetHeader className="pr-10">
          <SheetTitle className="line-clamp-2">
            {item?.item_title || "Quick edit"}
          </SheetTitle>
          <SheetDescription>
            {[
              item?.item_number ? `SKU ${item.item_number}` : null,
              index >= 0 && items.length > 1 ? `${index + 1} of ${items.length} on this page` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Edit item details"}
          </SheetDescription>
          {onSelect && items.length > 1 && (
            <div className="flex items-center gap-1 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void go(prev)}
                disabled={!prev || saving}
                aria-label="Previous item"
              >
                <ChevronUp className="h-4 w-4" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void go(next)}
                disabled={!next || saving}
                aria-label="Next item"
              >
                <ChevronDown className="h-4 w-4" />
                Next
              </Button>
              <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
                Up/Down saves and moves to the next item.
              </span>
            </div>
          )}
        </SheetHeader>

        {form && item && (
          <div className="space-y-4 px-4 pb-2">
            <div className="space-y-1.5">
              <Label htmlFor="quick-edit-title">Title</Label>
              <Input
                id="quick-edit-title"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Item title"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="quick-edit-status">Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => set("status", v as ItemStatus)}
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
                <Label htmlFor="quick-edit-bin">Bin / location</Label>
                <Input
                  id="quick-edit-bin"
                  value={form.bin}
                  onChange={(e) => set("bin", e.target.value)}
                  placeholder="e.g. A3"
                />
              </div>
            </div>

            {item.listing_id && (
              <div className="space-y-1.5">
                <Label htmlFor="quick-edit-list-price">Listed price</Label>
                <Input
                  id="quick-edit-list-price"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={form.listPrice}
                  onChange={(e) => set("listPrice", e.target.value)}
                  placeholder="0.00"
                />
                <p className="text-xs text-muted-foreground">
                  {live
                    ? `Saving changes the price buyers see${platform ? ` on ${platform}` : ""}.`
                    : "The price on the listing record."}
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="quick-edit-target">Asking price</Label>
                <Input
                  id="quick-edit-target"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={form.targetPrice}
                  onChange={(e) => set("targetPrice", e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quick-edit-cost">Cost</Label>
                <Input
                  id="quick-edit-cost"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={form.cost}
                  onChange={(e) => set("cost", e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="quick-edit-notes">Notes</Label>
              <Textarea
                id="quick-edit-notes"
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                placeholder="Internal notes"
                rows={3}
              />
            </div>

            {plan && plan.errors.length > 0 && (
              <p role="alert" className="text-sm text-destructive">
                {plan.errors[0]}
              </p>
            )}
          </div>
        )}

        <SheetFooter className="flex-row flex-wrap items-center justify-between gap-2">
          {item && onOpenFull ? (
            <Button variant="ghost" size="sm" onClick={() => onOpenFull(item)}>
              <ExternalLink className="mr-1.5 h-4 w-4" />
              Full editor
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveAndClose()}
              disabled={saving || !plan?.changed || (plan?.errors.length ?? 0) > 0}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
