import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { useRecentStore } from "@/stores/recent-store";
import {
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
  ITEM_CATEGORIES,
} from "@/lib/constants";
import { CompEditor } from "@/components/flipdesk/comp-editor";
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import { MeasurementForm } from "@/components/flipdesk/measurement-form";
import { PnlPanel } from "@/components/flipdesk/pnl-panel";
import type {
  ItemComp,
  ItemFullRow,
  ItemStatus,
  ItemCategory,
} from "@/types/database";

type Props = {
  item: ItemFullRow | null;
  onClose: () => void;
};

type EditState = {
  // inventory_items
  title: string;
  sku: string;
  container: string;
  brand: string;
  style: string;
  size: string;
  description: string;
  condition_notes: string;
  item_category: ItemCategory | "";
  sourced_by: string;
  status: ItemStatus;
  acquired_date: string;
  acquired_price: string;
  target_price: string;
  comp_set: ItemComp[];
  measurements: Record<string, number | string>;
};

function toState(item: ItemFullRow): EditState {
  return {
    title: item.item_title ?? "",
    sku: item.item_number ?? "",
    container: item.container ?? "",
    brand: item.brand ?? "",
    style: item.style ?? "",
    size: item.size ?? "",
    description: item.item_description ?? "",
    condition_notes: item.notes ?? "",
    item_category: (item.category as ItemCategory | null) ?? "",
    sourced_by: item.sourced_by ?? "",
    status: item.status,
    acquired_date: item.purchase_date?.slice(0, 10) ?? "",
    acquired_price:
      item.purchase_price == null ? "" : String(item.purchase_price),
    target_price: item.target_price == null ? "" : String(item.target_price),
    comp_set: Array.isArray(item.comps) ? item.comps : [],
    measurements:
      item.measurements && typeof item.measurements === "object"
        ? item.measurements
        : {},
  };
}

function trimOrNull(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

function priceOrNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function ItemDetailDialog({ item, onClose }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pushRecent = useRecentStore((s) => s.pushRecent);
  const [state, setState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setState(item ? toState(item) : null);
    // Record the opened item for the command-palette Recent section.
    if (item) pushRecent(item.id);
  }, [item, pushRecent]);

  if (!item || !state) return null;

  function patch<K extends keyof EditState>(k: K, v: EditState[K]) {
    setState((s) => (s ? { ...s, [k]: v } : s));
  }

  async function save() {
    if (!item || !state) return;
    setSaving(true);
    try {
      const update = {
        title: state.title.trim() || item.item_title,
        sku: trimOrNull(state.sku),
        container: trimOrNull(state.container),
        brand: trimOrNull(state.brand),
        style: trimOrNull(state.style),
        size: trimOrNull(state.size),
        description: trimOrNull(state.description),
        condition_notes: trimOrNull(state.condition_notes),
        item_category:
          state.item_category === "" ? null : state.item_category,
        sourced_by: trimOrNull(state.sourced_by),
        status: state.status,
        acquired_date: state.acquired_date || null,
        acquired_price: priceOrNull(state.acquired_price),
        target_price: priceOrNull(state.target_price),
        comp_set: state.comp_set.filter(
          (c) => Number.isFinite(c.price) && c.price > 0,
        ),
        measurements:
          Object.keys(state.measurements).length > 0
            ? state.measurements
            : null,
      };

      const { error } = await supabase
        .from("inventory_items")
        .update(update as never)
        .eq("id", item.id);
      if (error) throw error;

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Saved.");
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{state.title || "Untitled item"}</DialogTitle>
          <DialogDescription>
            SKU {item.item_number ?? "(none)"} · Status{" "}
            <span className="font-medium">
              {ITEM_STATUS_LABELS[item.status]}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <FieldText
            label="Title"
            value={state.title}
            onChange={(v) => patch("title", v)}
          />
          <FieldText
            label="SKU / Item #"
            value={state.sku}
            onChange={(v) => patch("sku", v)}
          />
          <FieldText
            label="Container"
            value={state.container}
            onChange={(v) => patch("container", v)}
          />
          <FieldText
            label="Brand"
            value={state.brand}
            onChange={(v) => patch("brand", v)}
          />
          <FieldText
            label="Style"
            value={state.style}
            onChange={(v) => patch("style", v)}
          />
          <FieldText
            label="Size"
            value={state.size}
            onChange={(v) => patch("size", v)}
          />
          <div className="space-y-1">
            <Label>Category</Label>
            <Select
              value={state.item_category || "__none"}
              onValueChange={(v) =>
                patch("item_category", v === "__none" ? "" : (v as ItemCategory))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">— None —</SelectItem>
                {ITEM_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Status</Label>
            <Select
              value={state.status}
              onValueChange={(v) => patch("status", v as ItemStatus)}
            >
              <SelectTrigger>
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
          <FieldText
            label="Sourced By"
            value={state.sourced_by}
            onChange={(v) => patch("sourced_by", v)}
          />
          <FieldText
            label="Purchase Date"
            value={state.acquired_date}
            onChange={(v) => patch("acquired_date", v)}
            type="date"
          />
          <FieldText
            label="Purchase Price"
            value={state.acquired_price}
            onChange={(v) => patch("acquired_price", v)}
            type="number"
          />
          <FieldText
            label="Target Price"
            value={state.target_price}
            onChange={(v) => patch("target_price", v)}
            type="number"
          />
        </div>

        <div className="space-y-2">
          <Label>Measurements</Label>
          <MeasurementForm
            category={item.category}
            brand={state.brand}
            values={state.measurements}
            onChange={(m) => patch("measurements", m)}
          />
        </div>

        <div className="space-y-2">
          <Label>Photos</Label>
          <p className="text-xs text-muted-foreground">
            Upload the required set (front, back, tag, detail) before sending
            the item to GradeThread or listing it.
          </p>
          <PhotoUploader itemId={item.id} />
        </div>

        <div className="space-y-2">
          <Label>Comps</Label>
          <p className="text-xs text-muted-foreground">
            Track sold comparable items to set a target price. The eBay
            search opens a sold-listings filter for this item.
          </p>
          <CompEditor
            comps={state.comp_set}
            onChange={(next) => patch("comp_set", next)}
            brand={state.brand}
            style={state.style}
            size={state.size}
            title={state.title}
            onSuggestTarget={(price) =>
              patch("target_price", price.toFixed(2))
            }
          />
        </div>

        <div className="space-y-1">
          <Label>Description (public)</Label>
          <Textarea
            value={state.description}
            onChange={(e) => patch("description", e.target.value)}
            rows={3}
          />
        </div>

        <div className="space-y-1">
          <Label>Notes (internal)</Label>
          <Textarea
            value={state.condition_notes}
            onChange={(e) => patch("condition_notes", e.target.value)}
            rows={3}
          />
        </div>

        {/* Per-item P&L (US-126) — only when a sale exists */}
        {item.sale_price != null && (
          <div className="space-y-2">
            <Label>Profit &amp; loss</Label>
            <PnlPanel
              inventoryItemId={item.id}
              costBasis={item.purchase_price}
            />
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            onClick={() => {
              onClose();
              navigate(`/dashboard/flipdesk/items/${item.id}/draft`);
            }}
            disabled={saving}
          >
            <FileText className="mr-2 h-4 w-4" />
            Draft listing
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldText({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "date" | "number";
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
