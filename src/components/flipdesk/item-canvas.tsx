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
  ArrowRight,
  Ruler,
  Camera,
  Tag,
  Rocket,
  DollarSign,
  Truck,
  PackageCheck,
  Clock,
  CircleCheck,
  Award,
  Hourglass,
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
import { Badge } from "@/components/ui/badge";
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
import { useWorkspace } from "@/hooks/use-workspace";
import {
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
  ITEM_CATEGORIES,
} from "@/lib/constants";
import { CompEditor } from "@/components/flipdesk/comp-editor";
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import { PhotoManager } from "@/components/flipdesk/photo-manager";
import { MeasurementForm } from "@/components/flipdesk/measurement-form";
import { PnlPanel } from "@/components/flipdesk/pnl-panel";
import { MarkListedDialog } from "@/components/flipdesk/mark-listed-dialog";
import { RecordSaleDialog } from "@/components/flipdesk/record-sale-dialog";
import { CategoryCheckCard } from "@/components/flipdesk/category-check-card";
import { GradeThisItemCard } from "@/components/flipdesk/grade-this-item-card";
import {
  resolveStatus,
  nextAction,
  rankOf,
  type NextActionKind,
} from "@/lib/workflow";
import { advanceItemStatus } from "@/lib/status-writer";
import { cn } from "@/lib/utils";
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

interface Props {
  item: ItemFullRow;
  // Called after a successful save / duplicate / relist. The dialog wrapper
  // uses this to close itself; the page wrapper leaves it undefined so the
  // user stays on the item to keep working.
  onAfterSave?: () => void;
  // Called on Cancel and just before "Draft listing" navigates away.
  onCancel?: () => void;
  // When true, renders the editable header (title + sub-meta) at the top.
  // The dialog wrapper supplies its own header, so it passes false.
  showHeader?: boolean;
}

type EditState = {
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

// The shared editing canvas for one inventory item. Rendered standalone in a
// route page or wrapped in a Dialog from list rows — owns no chrome, only the
// content.
export function ItemCanvas({
  item,
  onAfterSave,
  onCancel,
  showHeader = true,
}: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pushRecent = useRecentStore((s) => s.pushRecent);
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId } = useWorkspace();
  const [state, setState] = useState<EditState>(() => toState(item));
  const [saving, setSaving] = useState(false);
  const [markListedItem, setMarkListedItem] = useState<ItemFullRow | null>(null);
  const [recordSaleItem, setRecordSaleItem] = useState<ItemFullRow | null>(null);

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
    null,
  );
  const [copyOpen, setCopyOpen] = useState(false);

  // Re-seed state when the underlying item identity changes.
  useEffect(() => {
    setState(toState(item));
    setAiResult(null);
    setAiPanelOpen(false);
    setAiFields(new Set());
    setAiMeta({});
    pushRecent(item.id);
  }, [item, pushRecent]);

  // color/material live on inventory_items but not the items_full view —
  // pull them in once the canvas mounts for this item.
  useEffect(() => {
    let cancelled = false;
    void supabase
      .from("inventory_items")
      .select("color, material")
      .eq("id", item.id)
      .single()
      .then(({ data }) => {
        if (cancelled || !data) return;
        const row = data as { color: string | null; material: string | null };
        setState((s) => ({
          ...s,
          color: row.color ?? "",
          material: row.material ?? "",
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  function patch<K extends keyof EditState>(k: K, v: EditState[K]) {
    setState((s) => ({ ...s, [k]: v }));
    setAiFields((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
  }

  async function handleCompleteWithAi() {
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
        }.`,
      );
    }
  }

  async function save() {
    setSaving(true);
    try {
      const targetPrice = priceOrNull(state.target_price);
      const resolvedStatus = resolveStatus(item.status, state.status, {
        hasMeasurements: Object.keys(state.measurements).length > 0,
        hasRequiredPhotos: item.has_required_photos === true,
        hasTargetPrice: targetPrice != null,
        hasDraftListing: item.listing_id != null,
      });

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
      onAfterSave?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  async function duplicate() {
    if (!user || !workspaceOwnerId) return;
    try {
      const category = (ITEM_CATEGORIES as readonly string[]).includes(
        item.category ?? "",
      )
        ? (item.category as ItemCategory)
        : null;
      const { error } = await supabase.from("inventory_items").insert({
        user_id: workspaceOwnerId,
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
      onAfterSave?.();
    } catch (err) {
      toast.error(
        `Duplicate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function relist() {
    try {
      const { error } = await supabase
        .from("inventory_items")
        .update({ status: "drafted" } as never)
        .eq("id", item.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Item moved back to Draft for relisting.");
      onAfterSave?.();
    } catch (err) {
      toast.error(
        `Relist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Forward-only quick advance for post-prep transitions (ship, complete).
  async function advanceStatus(target: ItemStatus) {
    try {
      const advanced = await advanceItemStatus(item.id, item.status, target);
      if (!advanced) return;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(`Marked ${ITEM_STATUS_LABELS[target].toLowerCase()}.`);
    } catch (err) {
      toast.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function scrollToCanvasSection(id: string) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const action = nextAction(item);
  const NEXT_ACTION_ICON: Record<NextActionKind, typeof Ruler> = {
    measure: Ruler,
    photograph: Camera,
    grade: Award,
    grading: Hourglass,
    review_grade: Sparkles,
    comp: Tag,
    draft: FileText,
    list: Rocket,
    sell: Clock,
    ship: Truck,
    complete: PackageCheck,
    relist: RotateCcw,
    done: CircleCheck,
    none: Clock,
  };
  const NextActionIcon = NEXT_ACTION_ICON[action.kind];
  const NEXT_ACTION_CTA: Partial<Record<NextActionKind, string>> = {
    measure: "Add measurements",
    photograph: "Add photos",
    grade: "Submit for grading",
    review_grade: "View grade",
    comp: "Set price",
    draft: "Open composer",
    list: "Mark listed",
    ship: "Mark shipped",
    complete: "Mark complete",
    relist: "Move to Draft",
  };
  const actionable =
    action.tone === "todo" || action.tone === "ready";

  function runNextAction() {
    switch (action.kind) {
      case "measure":
        scrollToCanvasSection("canvas-measurements");
        break;
      case "photograph":
        scrollToCanvasSection("canvas-photos");
        break;
      case "grade":
      case "review_grade":
        scrollToCanvasSection("canvas-grading");
        break;
      case "comp":
        scrollToCanvasSection("canvas-comps");
        break;
      case "draft":
        onCancel?.();
        navigate(`/dashboard/flipdesk/items/${item.id}/draft`);
        break;
      case "list":
        setMarkListedItem(item);
        break;
      case "ship":
        void advanceStatus("shipped");
        break;
      case "complete":
        void advanceStatus("completed");
        break;
      case "relist":
        void relist();
        break;
      default:
        break;
    }
  }

  // Contextual "move to" actions for the overflow menu — reach states the
  // pinned CTA can't directly drive (e.g. record a sale while listed).
  const showMarkListedAction =
    rankOf(item.status) >= rankOf("comped") &&
    rankOf(item.status) < rankOf("listed");
  const showRecordSaleAction = item.status === "listed";
  const showShipAction = item.status === "sold";
  const showCompleteAction = item.status === "shipped";

  const missingCount = ENRICHABLE_FIELDS.filter(
    (f) => !String(state[f] ?? "").trim(),
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
      <div className="space-y-4">
        {showHeader && (
          <div className="space-y-1">
            <h2 className="text-xl font-bold tracking-tight">
              {state.title || "Untitled item"}
            </h2>
            <p className="text-sm text-muted-foreground">
              SKU {item.item_number ?? "(none)"} ·{" "}
              <Badge variant="outline" className="font-normal">
                {ITEM_STATUS_LABELS[item.status]}
              </Badge>
            </p>
          </div>
        )}

        {/* Pinned "Next action" CTA — drives the workflow forward. */}
        {action.kind !== "none" && (
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-4 p-3",
              action.tone === "ready" &&
                "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20",
              action.tone === "todo" &&
                "border-amber-500 bg-amber-50 dark:bg-amber-950/20",
              (action.tone === "muted" || action.tone === "done") &&
                "border-muted bg-muted/30",
            )}
          >
            <div className="flex items-center gap-3">
              <NextActionIcon className="h-5 w-5 flex-shrink-0" />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Next action
                </p>
                <p className="text-sm font-semibold">{action.label}</p>
              </div>
            </div>
            {actionable && NEXT_ACTION_CTA[action.kind] && (
              <Button size="sm" onClick={runNextAction}>
                {NEXT_ACTION_CTA[action.kind]}
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}

        {/* Complete with AI — emphasized when the item has gaps. */}
        {missingCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-primary" />
              {missingCount} field{missingCount === 1 ? "" : "s"} missing — let
              AI fill the gaps.
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
                patch(
                  "item_category",
                  v === "__none" ? "" : (v as ItemCategory),
                )
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

        <div id="canvas-measurements" className="space-y-2 scroll-mt-4">
          <Label>Measurements</Label>
          <MeasurementForm
            category={item.category}
            brand={state.brand}
            values={state.measurements}
            onChange={(m) => patch("measurements", m)}
            aiSources={item.ai_field_sources}
          />
        </div>

        <div id="canvas-photos" className="space-y-2 scroll-mt-4">
          <Label>Photos</Label>
          <p className="text-xs text-muted-foreground">
            Upload the required set (front, back, tag, detail) before sending
            the item to GradeThread or listing it.
          </p>
          <PhotoUploader itemId={item.id} currentStatus={item.status} />
          <div className="pt-2">
            <p className="text-xs font-medium text-muted-foreground">
              Reorder &amp; retag
            </p>
            <PhotoManager itemId={item.id} />
          </div>
        </div>

        <div id="canvas-grading" className="scroll-mt-4">
          <GradeThisItemCard item={item} />
        </div>

        {/* eBay category check — only when the item has an active eBay
            listing. Useful for catching listings filed under a suboptimal
            category, which hurts search visibility. */}
        {item.listing_id &&
          (item.status === "listed" || item.status === "comped") && (
            <CategoryCheckCard listingId={item.listing_id} />
          )}

        <div id="canvas-comps" className="space-y-2 scroll-mt-4">
          <Label>Comps</Label>
          <p className="text-xs text-muted-foreground">
            Track sold comparable items to set a target price. The eBay search
            opens a sold-listings filter for this item.
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

        {item.sale_price != null && (
          <div className="space-y-2">
            <Label>Profit &amp; loss</Label>
            <PnlPanel
              inventoryItemId={item.id}
              costBasis={item.purchase_price}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                onCancel?.();
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
                <Button
                  variant="outline"
                  size="icon"
                  disabled={saving}
                  aria-label="Item actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={duplicate}>
                  <Copy className="mr-2 h-4 w-4" />
                  Duplicate item
                </DropdownMenuItem>
                {showMarkListedAction && (
                  <DropdownMenuItem onClick={() => setMarkListedItem(item)}>
                    <Rocket className="mr-2 h-4 w-4" />
                    Mark as listed
                  </DropdownMenuItem>
                )}
                {showRecordSaleAction && (
                  <DropdownMenuItem onClick={() => setRecordSaleItem(item)}>
                    <DollarSign className="mr-2 h-4 w-4" />
                    Record sale
                  </DropdownMenuItem>
                )}
                {showShipAction && (
                  <DropdownMenuItem onClick={() => void advanceStatus("shipped")}>
                    <Truck className="mr-2 h-4 w-4" />
                    Mark as shipped
                  </DropdownMenuItem>
                )}
                {showCompleteAction && (
                  <DropdownMenuItem
                    onClick={() => void advanceStatus("completed")}
                  >
                    <PackageCheck className="mr-2 h-4 w-4" />
                    Mark complete
                  </DropdownMenuItem>
                )}
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
            <Button variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>

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
                      p ? { ...p, description: e.target.value } : p,
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

      <MarkListedDialog
        item={markListedItem}
        onClose={() => setMarkListedItem(null)}
      />
      <RecordSaleDialog
        item={recordSaleItem}
        onClose={() => setRecordSaleItem(null)}
      />
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
