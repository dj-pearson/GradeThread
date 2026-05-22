import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FileText,
  MoreHorizontal,
  Copy,
  RotateCcw,
  Sparkles,
  Loader2,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { useRecentStore } from "@/stores/recent-store";
import { useAuthStore } from "@/stores/auth-store";
import {
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
  ITEM_CATEGORIES,
} from "@/lib/constants";
import { CompEditor } from "@/components/flipdesk/comp-editor";
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import { MeasurementForm } from "@/components/flipdesk/measurement-form";
import { PnlPanel } from "@/components/flipdesk/pnl-panel";
import { resolveStatus } from "@/lib/workflow";
import {
  AiFillPanel,
  type AcceptedField,
} from "@/components/flipdesk/ai-fill-panel";
import {
  useAiExtract,
  useListingCopy,
  type AiExtractResponse,
} from "@/hooks/use-ai-extract";
import type {
  ItemComp,
  ItemFullRow,
  ItemStatus,
  ItemCategory,
  AiFieldSource,
} from "@/types/database";

// Fields the "Complete with AI" action targets.
const ENRICHABLE_FIELDS = [
  "brand",
  "style",
  "size",
  "color",
  "material",
  "item_category",
] as const;

const AI_FIELD_LABELS: Record<string, string> = {
  item_category: "Category",
  condition_notes: "Internal notes",
};

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
  color: string;
  material: string;
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
    // color/material are not in the items_full view — loaded separately.
    color: "",
    material: "",
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
  const user = useAuthStore((s) => s.user);
  const [state, setState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  // AI enrichment ("Complete with AI")
  const aiExtract = useAiExtract();
  const [aiResult, setAiResult] = useState<AiExtractResponse | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiFields, setAiFields] = useState<Set<string>>(new Set());
  const [aiMeta, setAiMeta] = useState<
    Record<string, { source: string; confidence: number }>
  >({});

  // AI listing-copy generation
  const listingCopy = useListingCopy();
  const [copy, setCopy] = useState<{ title: string; description: string } | null>(
    null
  );
  const [copyOpen, setCopyOpen] = useState(false);

  useEffect(() => {
    setState(item ? toState(item) : null);
    setAiResult(null);
    setAiPanelOpen(false);
    setAiFields(new Set());
    setAiMeta({});
    // Record the opened item for the command-palette Recent section.
    if (item) pushRecent(item.id);
  }, [item, pushRecent]);

  // color/material live on inventory_items but not the items_full view —
  // pull them in once the dialog opens.
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    void supabase
      .from("inventory_items")
      .select("color, material")
      .eq("id", item.id)
      .single()
      .then(({ data }) => {
        if (cancelled || !data) return;
        const row = data as { color: string | null; material: string | null };
        setState((s) =>
          s
            ? { ...s, color: row.color ?? "", material: row.material ?? "" }
            : s
        );
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  if (!item || !state) return null;

  function patch<K extends keyof EditState>(k: K, v: EditState[K]) {
    setState((s) => (s ? { ...s, [k]: v } : s));
    // A manual edit clears the AI marker on that field.
    setAiFields((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
  }

  async function handleCompleteWithAi() {
    if (!item || !state) return;
    // Photo URLs from the public item-photos bucket.
    const { data: photoRows } = await supabase
      .from("item_photos")
      .select("photo_type, storage_path")
      .eq("inventory_item_id", item.id);
    const photos = ((photoRows ?? []) as {
      photo_type: string;
      storage_path: string;
    }[]).map((p) => ({
      url: supabase.storage
        .from("item-photos")
        .getPublicUrl(p.storage_path).data.publicUrl,
      type: p.photo_type,
    }));

    const text = [state.title, state.description, state.condition_notes]
      .filter((s) => s.trim())
      .join("\n");
    if (photos.length === 0 && !text.trim()) {
      toast.error("Add photos or a description for the AI to work from.");
      return;
    }

    const known: Record<string, unknown> = {};
    for (const k of ENRICHABLE_FIELDS) {
      const v = state[k];
      if (v && String(v).trim()) known[k] = v;
    }

    try {
      const result = await aiExtract.mutateAsync({
        text: text || undefined,
        photos,
        known_fields: known,
        item_id: item.id,
      });
      setAiResult(result);
      setAiPanelOpen(true);
    } catch {
      /* error toast handled by the hook */
    }
  }

  async function handleGenerateCopy() {
    if (!item) return;
    try {
      const result = await listingCopy.mutateAsync({ item_id: item.id });
      setCopy({ title: result.title, description: result.description });
      setCopyOpen(true);
    } catch {
      /* error toast handled by the hook */
    }
  }

  function applyAiFields(accepted: AcceptedField[]) {
    const allowed = new Set<string>([
      ...ENRICHABLE_FIELDS,
      "title",
      "condition_notes",
    ]);
    setState((s) => {
      if (!s) return s;
      const next = { ...s } as unknown as Record<string, unknown>;
      for (const a of accepted) {
        if (allowed.has(a.field)) next[a.field] = a.value;
      }
      return next as unknown as EditState;
    });
    setAiFields((prev) => {
      const next = new Set(prev);
      for (const a of accepted) next.add(a.field);
      return next;
    });
    setAiMeta((prev) => {
      const next = { ...prev };
      for (const a of accepted) {
        next[a.field] = { source: a.source, confidence: a.confidence };
      }
      return next;
    });
    if (accepted.length > 0) {
      toast.success(
        `Applied ${accepted.length} AI suggestion${
          accepted.length === 1 ? "" : "s"
        }.`
      );
    }
  }

  async function save() {
    if (!item || !state) return;
    setSaving(true);
    try {
      const targetPrice = priceOrNull(state.target_price);
      // Auto-advance status forward from completed work; manual picks of
      // non-prep statuses still win. Never regresses.
      const resolvedStatus = resolveStatus(item.status, state.status, {
        hasMeasurements: Object.keys(state.measurements).length > 0,
        hasRequiredPhotos: item.has_required_photos === true,
        hasTargetPrice: targetPrice != null,
        hasDraftListing: item.listing_id != null,
      });

      // AI provenance for fields filled this session.
      const aiFieldSources: Record<string, AiFieldSource> = {};
      for (const field of aiFields) {
        const meta = aiMeta[field];
        aiFieldSources[field] = {
          source: meta?.source ?? "text",
          confidence: meta?.confidence ?? 0,
          accepted: true,
        };
      }
      const hasAiFields = Object.keys(aiFieldSources).length > 0;

      const update: Record<string, unknown> = {
        title: state.title.trim() || item.item_title,
        sku: trimOrNull(state.sku),
        container: trimOrNull(state.container),
        brand: trimOrNull(state.brand),
        style: trimOrNull(state.style),
        size: trimOrNull(state.size),
        color: trimOrNull(state.color),
        material: trimOrNull(state.material),
        description: trimOrNull(state.description),
        condition_notes: trimOrNull(state.condition_notes),
        item_category:
          state.item_category === "" ? null : state.item_category,
        sourced_by: trimOrNull(state.sourced_by),
        status: resolvedStatus,
        acquired_date: state.acquired_date || null,
        acquired_price: priceOrNull(state.acquired_price),
        target_price: targetPrice,
        comp_set: state.comp_set.filter(
          (c) => Number.isFinite(c.price) && c.price > 0,
        ),
        measurements:
          Object.keys(state.measurements).length > 0
            ? state.measurements
            : null,
      };

      if (hasAiFields) {
        update.ai_field_sources = aiFieldSources;
        update.ai_enriched_at = new Date().toISOString();
      }

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

  // Duplicate — copies item-level fields into a fresh row (for buying
  // multiples of the same thing). Photos/listings/sales are NOT copied.
  async function duplicate() {
    if (!item || !user) return;
    try {
      const category = (ITEM_CATEGORIES as readonly string[]).includes(
        item.category ?? "",
      )
        ? (item.category as ItemCategory)
        : null;
      const { error } = await supabase.from("inventory_items").insert({
        user_id: user.id,
        title: item.item_title,
        brand: item.brand,
        style: item.style,
        size: item.size,
        item_category: category,
        source_id: item.source_id,
        sourced_by: item.sourced_by,
        acquired_price: item.purchase_price,
        acquired_date: item.purchase_date,
        description: item.item_description,
        condition_notes: item.notes,
        measurements: item.measurements,
        status: "cataloged",
      } as never);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Duplicated. The copy is in Cataloged.");
      onClose();
    } catch (err) {
      toast.error(
        `Duplicate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Relist — sends a returned/completed item back to Drafted to re-enter
  // the listing flow. Photos and measurements are kept.
  async function relist() {
    if (!item) return;
    try {
      const { error } = await supabase
        .from("inventory_items")
        .update({ status: "drafted" } as never)
        .eq("id", item.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Item moved back to Draft for relisting.");
      onClose();
    } catch (err) {
      toast.error(
        `Relist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const missingCount = ENRICHABLE_FIELDS.filter(
    (f) => !String(state[f] ?? "").trim()
  ).length;
  const hasAiText = [
    state.title,
    state.description,
    state.condition_notes,
  ].some((s) => s.trim());
  const canComplete =
    missingCount > 0 && (item.photo_count > 0 || hasAiText);

  return (
    <>
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

        {/* Complete with AI — emphasized when the item has gaps. */}
        {missingCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-primary" />
              {missingCount} field{missingCount === 1 ? "" : "s"} missing —
              let AI fill the gaps.
            </p>
            <Button
              size="sm"
              onClick={handleCompleteWithAi}
              disabled={!canComplete || aiExtract.isPending}
              title={
                canComplete
                  ? undefined
                  : "Add photos or a description first so the AI has something to read."
              }
            >
              {aiExtract.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Complete with AI
            </Button>
          </div>
        )}

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
            aiMarked={aiFields.has("brand")}
          />
          <FieldText
            label="Style"
            value={state.style}
            onChange={(v) => patch("style", v)}
            aiMarked={aiFields.has("style")}
          />
          <FieldText
            label="Size"
            value={state.size}
            onChange={(v) => patch("size", v)}
            aiMarked={aiFields.has("size")}
          />
          <FieldText
            label="Color"
            value={state.color}
            onChange={(v) => patch("color", v)}
            aiMarked={aiFields.has("color")}
          />
          <FieldText
            label="Material"
            value={state.material}
            onChange={(v) => patch("material", v)}
            aiMarked={aiFields.has("material")}
          />
          <div className="space-y-1">
            <Label>
              Category
              {aiFields.has("item_category") && (
                <span className="ml-1.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
                  AI
                </span>
              )}
            </Label>
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
          <PhotoUploader itemId={item.id} currentStatus={item.status} />
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
          <div className="flex gap-2">
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
            <Button
              variant="outline"
              onClick={handleGenerateCopy}
              disabled={saving || listingCopy.isPending}
            >
              {listingCopy.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Generate listing copy
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" disabled={saving}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={duplicate}>
                  <Copy className="mr-2 h-4 w-4" />
                  Duplicate item
                </DropdownMenuItem>
                {(item.status === "returned" ||
                  item.status === "completed") && (
                  <DropdownMenuItem onClick={relist}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Relist (back to Draft)
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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

    <AiFillPanel
      open={aiPanelOpen}
      onOpenChange={setAiPanelOpen}
      result={aiResult}
      currentValues={{
        title: state.title,
        brand: state.brand,
        style: state.style,
        size: state.size,
        color: state.color,
        material: state.material,
        item_category: state.item_category,
        condition_notes: state.condition_notes,
      }}
      fieldLabels={AI_FIELD_LABELS}
      onApply={applyAiFields}
    />

    {/* AI listing-copy review */}
    <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Generated listing copy
          </DialogTitle>
          <DialogDescription>
            Review and edit before applying. Nothing is saved until you Apply.
          </DialogDescription>
        </DialogHeader>
        {copy && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Listing title</Label>
              <Input
                value={copy.title}
                onChange={(e) =>
                  setCopy((p) => (p ? { ...p, title: e.target.value } : p))
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Listing description</Label>
              <Textarea
                value={copy.description}
                rows={10}
                onChange={(e) =>
                  setCopy((p) =>
                    p ? { ...p, description: e.target.value } : p
                  )
                }
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setCopyOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (copy) {
                if (copy.title.trim()) patch("title", copy.title.trim());
                patch("description", copy.description);
                toast.success("Listing copy applied. Save to keep it.");
              }
              setCopyOpen(false);
            }}
          >
            Apply to item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function FieldText({
  label,
  value,
  onChange,
  type = "text",
  aiMarked = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "date" | "number";
  aiMarked?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>
        {label}
        {aiMarked && (
          <span className="ml-1.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
            AI
          </span>
        )}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
