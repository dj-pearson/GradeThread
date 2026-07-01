import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  Lock,
  ExternalLink,
  Pencil,
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
  ITEM_CATEGORY_LABELS,
  GARMENT_TYPES,
  GARMENT_CATEGORIES,
  REQUIRED_PHOTO_TYPES,
} from "@/lib/constants";
import { deriveGarmentDefaults } from "@/lib/garment-mapping";
import { useEbayReviseListing, type ReviseListingPatch } from "@/hooks/use-ebay";
import { CompEditor } from "@/components/flipdesk/comp-editor";
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import { PhotoManager } from "@/components/flipdesk/photo-manager";
import { MeasurementForm } from "@/components/flipdesk/measurement-form";
import { PnlPanel } from "@/components/flipdesk/pnl-panel";
import { MarkListedDialog } from "@/components/flipdesk/mark-listed-dialog";
import { RecordSaleDialog } from "@/components/flipdesk/record-sale-dialog";
import {
  MergeSkuDialog,
  type MergeValues,
} from "@/components/flipdesk/merge-sku-dialog";
import { CategoryCheckCard } from "@/components/flipdesk/category-check-card";
import { EbayCatalogMatchCard } from "@/components/flipdesk/ebay-catalog-match-card";
import { GradeThisItemCard } from "@/components/flipdesk/grade-this-item-card";
import {
  resolveStatus,
  nextAction,
  rankOf,
  type NextActionKind,
} from "@/lib/workflow";
import { projectColumnAspects } from "@/lib/ebay-prefill";
import type { AspectSourceMap } from "@/lib/aspect-provenance";
import { advanceItemStatus } from "@/lib/status-writer";
import { deriveListingOrigin } from "@/lib/listing-origin";
import { cn } from "@/lib/utils";
import {
  AiFillPanel,
  type AcceptedField,
} from "@/components/flipdesk/ai-fill-panel";
import {
  useAiExtract,
  useAiSizeEstimate,
  useListingCopy,
  type AiExtractResponse,
} from "@/hooks/use-ai-extract";
import type {
  ItemComp,
  ItemFullRow,
  ItemStatus,
  ItemCategory,
  GarmentType,
  GarmentCategory,
  AiFieldSource,
  InventoryItemRow,
} from "@/types/database";

// Helper to render a human label from a kebab/snake enum value.
function enumLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Fields the "Complete with AI" action targets.
const ENRICHABLE_FIELDS = [
  "brand",
  "style",
  "size",
  "color",
  "material",
  "item_category",
  // Clothing grading inputs — the AI suggests these from photos (only for
  // clothing); applying them clears the grading-readiness blockers.
  "garment_type",
  "garment_category",
] as const;

const AI_FIELD_LABELS: Record<string, string> = {
  item_category: "Category",
  garment_type: "Garment Type",
  garment_category: "Garment Category",
  condition_notes: "Internal notes",
  description: "Description",
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
  // Clothing-specific grading inputs (required by the grading readiness gate
  // in flipdesk-grading.ts and by /api/grade/submit). Not on the items_full
  // view, so lazy-loaded from inventory_items alongside color/material.
  garment_type: GarmentType | "";
  garment_category: GarmentCategory | "";
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
    // garment_type/garment_category aren't on the items_full view — lazy-loaded.
    garment_type: "",
    garment_category: "",
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

// US-404: heavy/derived columns that the inventory list omits from its bulk
// load and the canvas lazy-loads for the single open item. Read defensively —
// when fed from the slim list query these are absent on `item`.
interface HeavyFields {
  photo_count: number;
  has_required_photos: boolean;
  ai_field_sources: ItemFullRow["ai_field_sources"];
}

// Mirrors the items_full view's has_required_photos definition (front + back;
// see the 00306 migration). Imported from constants so the two can't drift.

function heavyFromItem(item: ItemFullRow): HeavyFields {
  const partial = item as Partial<ItemFullRow>;
  return {
    photo_count: partial.photo_count ?? 0,
    has_required_photos: partial.has_required_photos ?? false,
    ai_field_sources: partial.ai_field_sources ?? null,
  };
}

// Form-shaped view of a raw inventory_items row, for the duplicate-SKU merge
// comparison (same string conventions as EditState).
function rowToMergeValues(row: InventoryItemRow): MergeValues {
  return {
    title: row.title ?? "",
    container: row.container ?? "",
    brand: row.brand ?? "",
    style: row.style ?? "",
    size: row.size ?? "",
    color: row.color ?? "",
    material: row.material ?? "",
    description: row.description ?? "",
    condition_notes: row.condition_notes ?? "",
    item_category: row.item_category ?? "",
    sourced_by: row.sourced_by ?? "",
    status: row.status,
    acquired_date: row.acquired_date?.slice(0, 10) ?? "",
    acquired_price:
      row.acquired_price == null ? "" : String(row.acquired_price),
    target_price: row.target_price == null ? "" : String(row.target_price),
    comp_set: Array.isArray(row.comp_set) ? row.comp_set : [],
    measurements:
      row.measurements && typeof row.measurements === "object"
        ? row.measurements
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
  // Baseline for the lazy-loaded color/material columns (absent from the
  // items_full view, so not on `item`). Captured when they load so buildEbayPatch
  // can tell whether the seller actually changed them and trigger the eBay sync.
  const loadedExtras = useRef({ color: "", material: "" });
  // Shared with <PhotoManager>: set true when a photo edit (reorder/retag/
  // rotate/delete) is made this session. Lets "Save & sync" push photo-only
  // changes (a rotate alone otherwise produced no eBay patch) and, once pushed,
  // clears it so PhotoManager's unmount auto-sync doesn't double-push.
  const photosDirtyRef = useRef(false);

  // Live-listing state drives the unified "Save & sync to eBay" behavior: a
  // GradeThread-published listing (one with a Sell API offer id) is revised in
  // place on save; an eBay-NATIVE listing (active but no offer) can only be
  // edited on eBay, so we never push to it (the parent shows that notice).
  const revise = useEbayReviseListing();
  const { data: liveListing } = useQuery({
    queryKey: ["item_ebay_sync", item.id],
    queryFn: async (): Promise<{
      id: string;
      platform_offer_id: string | null;
      platform_listing_id: string | null;
      listing_url: string | null;
      listing_title: string | null;
      listing_description: string | null;
      listing_price: number | null;
      batch_id: string | null;
      synced_to_ebay_at: string | null;
    } | null> => {
      const { data, error } = await supabase
        .from("listings")
        .select(
          "id, platform_offer_id, platform_listing_id, listing_url, listing_title, listing_description, listing_price, batch_id, synced_to_ebay_at",
        )
        .eq("inventory_item_id", item.id)
        .eq("listing_status", "active")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as {
        id: string;
        platform_offer_id: string | null;
        platform_listing_id: string | null;
        listing_url: string | null;
        listing_title: string | null;
        listing_description: string | null;
        listing_price: number | null;
        batch_id: string | null;
        synced_to_ebay_at: string | null;
      } | null;
    },
  });
  // US-1080: eBay-originated listings are a read-only mirror — eBay owns the
  // title/price/description, so those fields are locked in this editor (the
  // server rejects the write too). Provenance is derived until US-1077 persists
  // listing_origin.
  const ebayOrigin = liveListing
    ? deriveListingOrigin({
        platform: "ebay",
        platform_listing_id: liveListing.platform_listing_id,
        batch_id: liveListing.batch_id,
        synced_to_ebay_at: liveListing.synced_to_ebay_at,
      })
    : "gradethread";
  const lockedByEbay = ebayOrigin === "ebay";
  const ebayListingUrl = liveListing?.listing_url ?? null;
  // Only GradeThread-published listings (with a Sell offer) are revisable here,
  // and never an eBay-originated mirror.
  const isGtLive = !!liveListing?.platform_offer_id && !lockedByEbay;

  // US-404: the inventory LIST now omits these heavy/derived columns from its
  // bulk load (the per-row photo subqueries + the ai_field_sources jsonb) to
  // keep the wide items_full view off the list query. When a feeder still
  // supplies them (pipeline / standalone page) they show instantly; otherwise
  // we lazy-load them for this one open item below. Initialised from `item`
  // (which may be a partial row) with safe defaults.
  const [heavy, setHeavy] = useState<HeavyFields>(() => heavyFromItem(item));
  const [markListedItem, setMarkListedItem] = useState<ItemFullRow | null>(null);
  const [recordSaleItem, setRecordSaleItem] = useState<ItemFullRow | null>(null);

  // Duplicate-SKU merge: set when a save hits the (user_id, sku) unique
  // index — holds the record that already owns the SKU.
  const [mergeExisting, setMergeExisting] = useState<InventoryItemRow | null>(
    null,
  );
  const [merging, setMerging] = useState(false);

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
  const sizeAi = useAiSizeEstimate();

  // US-1088: Size AI — estimate a missing/cut-off size from the item's photos
  // (esp. measurement / flat-lay shots) vs the brand's sizing. Fills the Size
  // field; the button is only shown while Size is blank, so it disappears once
  // applied. Gender is surfaced in the toast (no dedicated gender field yet).
  async function runSizeAi() {
    try {
      const r = await sizeAi.mutateAsync({ item_id: item.id });
      if (!r.size) {
        toast.info(
          "Size AI couldn't read a size — add a measurement or flat-lay photo and retry.",
        );
        return;
      }
      patch("size", r.size);
      const genderNote = r.gender ? ` · ${r.gender}` : "";
      if (r.low_confidence) {
        toast.info(`Best guess: ${r.size}${genderNote}`, {
          description:
            r.rationale || "Low confidence — double-check before listing.",
        });
      } else {
        toast.success(`Size AI: ${r.size}${genderNote}`, {
          description: r.rationale || undefined,
        });
      }
    } catch {
      // useAiSizeEstimate's onError already surfaces the failure toast.
    }
  }
  const [copy, setCopy] = useState<{ title: string; description: string } | null>(
    null,
  );
  const [copyOpen, setCopyOpen] = useState(false);

  // Re-seed state when the underlying item identity changes.
  useEffect(() => {
    setState(toState(item));
    setHeavy(heavyFromItem(item));
    setAiResult(null);
    setAiPanelOpen(false);
    setAiFields(new Set());
    setAiMeta({});
    pushRecent(item.id);
  }, [item, pushRecent]);

  // color/material/ai_field_sources live on inventory_items but not (or, for
  // ai_field_sources, no longer) on the slim list query — pull them in once the
  // canvas mounts for this item (US-404).
  useEffect(() => {
    let cancelled = false;
    void supabase
      .from("inventory_items")
      .select("color, material, garment_type, garment_category, ai_field_sources")
      .eq("id", item.id)
      .single()
      .then(({ data }) => {
        if (cancelled || !data) return;
        const row = data as {
          color: string | null;
          material: string | null;
          garment_type: GarmentType | null;
          garment_category: GarmentCategory | null;
          ai_field_sources: ItemFullRow["ai_field_sources"];
        };
        loadedExtras.current = {
          color: row.color ?? "",
          material: row.material ?? "",
        };
        setState((s) => {
          // US-1423: if grading's garment fields were never captured at catalog,
          // pre-seed the selects from item_category (a deterministic default the
          // user can refine) instead of forcing a blank re-pick. Non-destructive
          // — only fills when the stored value is null; nothing persists until
          // the user hits Save.
          const derived =
            row.garment_type == null || row.garment_category == null
              ? deriveGarmentDefaults(s.item_category || null)
              : { garment_type: null, garment_category: null };
          return {
            ...s,
            color: row.color ?? "",
            material: row.material ?? "",
            garment_type: row.garment_type ?? derived.garment_type ?? "",
            garment_category:
              row.garment_category ?? derived.garment_category ?? "",
          };
        });
        setHeavy((h) => ({
          ...h,
          ai_field_sources: row.ai_field_sources ?? null,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  // Photo readiness (count + the front/back/tag/detail completeness flag) — the
  // items_full view computes these as per-row correlated subqueries, which the
  // list now omits (US-404). Derive them here for the single open item.
  useEffect(() => {
    let cancelled = false;
    void supabase
      .from("item_photos")
      .select("photo_type")
      .eq("inventory_item_id", item.id)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const rows = data as { photo_type: string }[];
        const types = new Set(rows.map((r) => r.photo_type));
        setHeavy((h) => ({
          ...h,
          photo_count: rows.length,
          has_required_photos: REQUIRED_PHOTO_TYPES.every((t) => types.has(t)),
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
      // The server also resolves the eBay category + item-specifics and
      // persists them on the item — refresh the mapping the composer /
      // category picker read so they open prefilled.
      if (result.ebay) {
        await qc.invalidateQueries({
          queryKey: ["inventory_item_ebay", item.id],
        });
        const filled = Object.keys(result.ebay.aspects).length;
        if (filled > 0) {
          toast.success(
            `eBay category + ${filled} item specific${filled === 1 ? "" : "s"} filled from photos.`,
          );
        }
      }
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
      // US-758: the AI Fill now also returns a buyer-facing listing
      // description; apply it to the item's description.
      "description",
    ]);
    // US-1080: title/description are eBay-owned on an eBay-originated listing —
    // never let an AI accept silently overwrite a locked field.
    if (lockedByEbay) {
      allowed.delete("title");
      allowed.delete("description");
    }
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

  // Writes one EditState to the database. Throws on failure so callers can
  // inspect the error (save() turns a duplicate-SKU 23505 into a merge offer).
  async function persist(
    s: EditState,
    successMessage = "Saved.",
    opts?: { silent?: boolean },
  ) {
    const targetPrice = priceOrNull(s.target_price);
    const resolvedStatus = resolveStatus(item.status, s.status, {
      hasMeasurements: Object.keys(s.measurements).length > 0,
      hasRequiredPhotos: heavy.has_required_photos === true,
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
      title: s.title.trim() || item.item_title,
      sku: trimOrNull(s.sku),
      container: trimOrNull(s.container),
      brand: trimOrNull(s.brand),
      style: trimOrNull(s.style),
      size: trimOrNull(s.size),
      color: trimOrNull(s.color),
      material: trimOrNull(s.material),
      description: trimOrNull(s.description),
      condition_notes: trimOrNull(s.condition_notes),
      item_category: s.item_category === "" ? null : s.item_category,
      garment_type: s.garment_type === "" ? null : s.garment_type,
      garment_category: s.garment_category === "" ? null : s.garment_category,
      sourced_by: trimOrNull(s.sourced_by),
      status: resolvedStatus,
      acquired_date: s.acquired_date || null,
      acquired_price: priceOrNull(s.acquired_price),
      target_price: targetPrice,
      comp_set: s.comp_set.filter(
        (c) => Number.isFinite(c.price) && c.price > 0,
      ),
      measurements:
        Object.keys(s.measurements).length > 0 ? s.measurements : null,
    };

    if (hasAiFields) {
      update.ai_field_sources = aiFieldSources;
      update.ai_enriched_at = new Date().toISOString();
    }

    // The structured columns own their eBay item specifics: project the current
    // Brand/Size/Color/Material/Style onto the stored aspect map on EVERY save so
    // the eBay specifics editor never needs a second, duplicate entry. Mirrors the
    // edge forceColumnAspects (publish/revise) so drafts and not-yet-published
    // items stay in sync too — not just live GradeThread listings. Written into
    // the SAME inventory_items update (no extra round-trip beyond the read).
    const columnFields = {
      brand: s.brand,
      size: s.size,
      color: s.color,
      material: s.material,
      style: s.style,
    };
    const { data: aspRaw } = await supabase
      .from("inventory_items")
      .select("ebay_aspects, ebay_aspect_sources")
      .eq("id", item.id)
      .maybeSingle();
    const aspRow = aspRaw as {
      ebay_aspects: Record<string, string[]> | null;
      ebay_aspect_sources: AspectSourceMap | null;
    } | null;
    const projected = projectColumnAspects(
      columnFields,
      aspRow?.ebay_aspects ?? {},
      aspRow?.ebay_aspect_sources ?? {},
    );
    update.ebay_aspects = projected.aspects;
    update.ebay_aspect_sources = projected.sources;

    const { error } = await supabase
      .from("inventory_items")
      .update(update as never)
      .eq("id", item.id);
    if (error) throw error;

    // Keep the per-listing canonical copy (listings.item_specifics_override, which
    // publish reads FIRST) in lockstep with the inventory mirror — otherwise a
    // drafted listing would keep serving the stale override at publish time.
    if (item.listing_id) {
      const { data: lstRaw } = await supabase
        .from("listings")
        .select("item_specifics_override, item_specifics_sources")
        .eq("id", item.listing_id)
        .maybeSingle();
      const lstRow = lstRaw as {
        item_specifics_override: Record<string, string[]> | null;
        item_specifics_sources: AspectSourceMap | null;
      } | null;
      const lp = projectColumnAspects(
        columnFields,
        lstRow?.item_specifics_override ?? {},
        lstRow?.item_specifics_sources ?? {},
      );
      await supabase
        .from("listings")
        .update({
          item_specifics_override: lp.aspects,
          item_specifics_sources: lp.sources,
        } as never)
        .eq("id", item.listing_id);
    }

    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (!opts?.silent) toast.success(successMessage);
    onAfterSave?.();
  }

  // Builds the revise patch for the live GradeThread listing, or null when
  // nothing eBay-relevant changed — so a save that only touched internal fields
  // (cost, bin, notes) never pays the ~5–8s eBay round-trip ("only sync when an
  // eBay field changed").
  function buildEbayPatch(): ReviseListingPatch | null {
    if (!liveListing) return null;
    const patch: ReviseListingPatch = {};
    const title = state.title.trim();
    const desc = state.description.trim();
    const price = priceOrNull(state.target_price);
    if (title && title !== (liveListing.listing_title ?? "").trim()) {
      patch.title = title;
    }
    if (desc !== (liveListing.listing_description ?? "").trim()) {
      patch.description = desc;
    }
    if (price != null && price > 0 && price !== liveListing.listing_price) {
      patch.listing_price = price;
    }
    // Brand / size / style / color / material / category / condition aren't in
    // the published listing snapshot; detect via dirty-vs-loaded-item so changing
    // any of them still triggers the inventory re-PUT (which now rebuilds the eBay
    // item specifics from these columns — US-1088+ — alongside condition + photos).
    // color/material aren't on the items_full view, so compare to the value that
    // was lazy-loaded into `loadedExtras`.
    const structuralChanged =
      state.brand.trim() !== (item.brand ?? "").trim() ||
      state.size.trim() !== (item.size ?? "").trim() ||
      state.style.trim() !== (item.style ?? "").trim() ||
      state.color.trim() !== loadedExtras.current.color.trim() ||
      state.material.trim() !== loadedExtras.current.material.trim() ||
      state.item_category !== ((item.category as string | null) ?? "") ||
      state.condition_notes.trim() !== (item.notes ?? "").trim();
    if (
      patch.title === undefined &&
      patch.description === undefined &&
      patch.listing_price === undefined &&
      !structuralChanged &&
      // A photo-only edit (e.g. a rotate persisted by PhotoManager) is still an
      // eBay-relevant change — push the current photo set even when no text/
      // structural field moved.
      !photosDirtyRef.current
    ) {
      return null;
    }
    // photos:true forces the inventory_item re-PUT so brand/specifics/condition
    // + the current photo set reach eBay alongside any changed text/price.
    patch.photos = true;
    return patch;
  }

  async function save() {
    setSaving(true);
    try {
      // Unified Save & sync: persist locally, then push to the live GradeThread
      // listing when an eBay-relevant field changed. A failed eBay push never
      // blocks the local save — we surface the reason and leave the row saved.
      const ebayPatch = isGtLive ? buildEbayPatch() : null;
      await persist(state, "Saved.", { silent: !!ebayPatch });
      if (ebayPatch && liveListing) {
        try {
          await revise.mutateAsync({
            listingId: liveListing.id,
            patch: ebayPatch,
          });
          // Photos (if any) reached eBay via this push — clear the shared flag so
          // PhotoManager's unmount auto-sync doesn't re-push the same change.
          photosDirtyRef.current = false;
          await qc.invalidateQueries({ queryKey: ["item_ebay_sync", item.id] });
          toast.success("Saved & synced to eBay.");
        } catch (e) {
          const err = e as Error & { status?: number };
          toast.error(`Saved locally, but eBay sync failed: ${err.message}`, {
            duration: 12_000,
          });
        }
      }
    } catch (err) {
      // Duplicate SKU (partial unique index on user_id, sku) → offer to merge
      // the two records instead of dead-ending on the raw Postgres error.
      const pgErr = err as { code?: string; message?: string };
      const sku = state.sku.trim();
      if (
        pgErr.code === "23505" &&
        sku &&
        (pgErr.message ?? "").includes("idx_inventory_items_user_sku")
      ) {
        const { data } = await supabase
          .from("inventory_items")
          .select("*")
          .eq("user_id", item.user_id)
          .eq("sku", sku)
          .neq("id", item.id)
          .maybeSingle();
        if (data) {
          setMergeExisting(data as InventoryItemRow);
          return;
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  // Confirmed duplicate-SKU merge: the RPC atomically re-points photos,
  // listings, sales and grading history from the existing record onto this
  // item, deletes it, and claims the SKU — then the user's field choices are
  // saved through the normal update path.
  async function handleMergeConfirm(overrides: Partial<MergeValues>) {
    if (!mergeExisting) return;
    const sku = state.sku.trim();
    setMerging(true);
    try {
      const rpcClient = supabase as unknown as {
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: Error | null }>;
      };
      const { error } = await rpcClient.rpc("merge_inventory_items", {
        p_survivor_id: item.id,
        p_duplicate_id: mergeExisting.id,
        p_sku: sku,
      });
      if (error) throw error;

      const next: EditState = { ...state, ...overrides, sku };
      setState(next);
      setMergeExisting(null);
      // Photos/listings/sales were re-pointed server-side — refresh everything
      // that might render the absorbed record.
      await qc.invalidateQueries();
      try {
        await persist(next, "Records merged — this item now owns the SKU.");
      } catch (persistErr) {
        // The merge itself committed; only the field choices failed to save.
        toast.error(
          `Records merged, but saving your field choices failed: ${
            persistErr instanceof Error
              ? persistErr.message
              : String(persistErr)
          }. Review the item and save again.`,
        );
      }
    } catch (err) {
      toast.error(
        `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setMerging(false);
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
  // US-1490: a GradeThread-originated live listing can be revised in the
  // composer (which doubles as the live-listing editor). eBay-originated mirrors
  // are read-only (lockedByEbay) and instead link out to eBay above.
  const showEditListingAction =
    item.status === "listed" && !!item.listing_id && !lockedByEbay;
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
    missingCount > 0 && (heavy.photo_count > 0 || hasAiText);

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

        {/* US-1080: eBay-originated listing — read-only mirror. eBay owns the
            title/price/description/photos; those fields are locked here and the
            server rejects edits to them. Send the seller to eBay to change them. */}
        {lockedByEbay && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
            <div className="flex items-start gap-2 text-amber-800 dark:text-amber-300">
              <Lock className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                This listing was created on eBay, so eBay owns its title, price,
                description, and photos — those are locked here. Your grade,
                notes, measurements, and cost stay editable. Edit the eBay-owned
                fields on eBay.
              </span>
            </div>
            {ebayListingUrl && (
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <a
                  href={ebayListingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Edit on eBay
                </a>
              </Button>
            )}
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
            disabled={lockedByEbay}
            lockHint={lockedByEbay}
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
          <div className="space-y-1.5">
            <FieldText
              label="Size"
              value={state.size}
              onChange={(v) => patch("size", v)}
              aiMarked={aiFields.has("size")}
            />
            {/* US-1088: Size AI — only while Size is blank (e.g. a cut-off
                Lululemon label); fills the field on success, then hides. */}
            {state.size.trim() === "" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={runSizeAi}
                disabled={sizeAi.isPending}
              >
                {sizeAi.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {sizeAi.isPending
                  ? "Analyzing photos…"
                  : "Size AI — estimate from photos"}
              </Button>
            )}
          </div>
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
                    {ITEM_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Clothing garment_type/garment_category — required by the grading
              gate (flipdesk-grading.ts) and /api/grade/submit. Only relevant for
              Clothing; non-clothing categories grade on item_category alone. */}
          {state.item_category === "clothing" && (
            <>
              <div className="space-y-1">
                <Label>
                  Garment Type
                  <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                    (required to grade)
                  </span>
                </Label>
                <Select
                  value={state.garment_type || "__none"}
                  onValueChange={(v) =>
                    patch(
                      "garment_type",
                      v === "__none" ? "" : (v as GarmentType),
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select garment type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— None —</SelectItem>
                    {GARMENT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {enumLabel(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>
                  Garment Category
                  <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                    (required to grade)
                  </span>
                </Label>
                <Select
                  value={state.garment_category || "__none"}
                  onValueChange={(v) =>
                    patch(
                      "garment_category",
                      v === "__none" ? "" : (v as GarmentCategory),
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select garment category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— None —</SelectItem>
                    {GARMENT_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {enumLabel(cat)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
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
            disabled={lockedByEbay}
            lockHint={lockedByEbay}
          />
        </div>

        <div id="canvas-measurements" className="space-y-2 scroll-mt-4">
          <Label>Measurements</Label>
          <MeasurementForm
            category={item.category}
            brand={state.brand}
            values={state.measurements}
            onChange={(m) => patch("measurements", m)}
            aiSources={heavy.ai_field_sources}
          />
        </div>

        <div id="canvas-photos" className="space-y-2 scroll-mt-4">
          <Label>Photos</Label>
          <p className="text-xs text-muted-foreground">
            Upload the required set (front, back, tag, detail) before sending
            the item to GradeThread or listing it.
          </p>
          <PhotoUploader
            itemId={item.id}
            currentStatus={item.status}
            category={item.category as ItemCategory | null}
          />
          <div className="pt-2">
            <p className="text-xs font-medium text-muted-foreground">
              Reorder &amp; retag
            </p>
            <PhotoManager
              itemId={item.id}
              liveListingId={isGtLive && liveListing ? liveListing.id : null}
              dirtyRef={photosDirtyRef}
            />
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

        {/* US-1475: match to an eBay catalog product (EPID) to auto-fill
            required item specifics. On-demand — no API call until clicked. */}
        <EbayCatalogMatchCard itemId={item.id} />

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
          <Label className={cn(lockedByEbay && "text-muted-foreground")}>
            Description (public)
            {lockedByEbay && (
              <Lock className="ml-1.5 inline h-3 w-3 align-[-1px] text-muted-foreground" />
            )}
          </Label>
          <Textarea
            value={state.description}
            onChange={(e) => patch("description", e.target.value)}
            rows={3}
            disabled={lockedByEbay}
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
              disabled={saving || listingCopy.isPending || lockedByEbay}
              title={
                lockedByEbay
                  ? "Title and description are managed on eBay for this listing."
                  : undefined
              }
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
                {showEditListingAction && (
                  <DropdownMenuItem
                    onClick={() => {
                      onCancel?.();
                      navigate(`/dashboard/flipdesk/items/${item.id}/draft`);
                    }}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit eBay listing
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
              {saving
                ? "Saving…"
                : isGtLive
                  ? "Save & sync to eBay"
                  : "Save changes"}
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
          garment_type: state.garment_type,
          garment_category: state.garment_category,
          condition_notes: state.condition_notes,
          description: state.description,
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

      {mergeExisting && (
        <MergeSkuDialog
          open
          sku={state.sku.trim()}
          current={state}
          existing={rowToMergeValues(mergeExisting)}
          merging={merging}
          onCancel={() => setMergeExisting(null)}
          onConfirm={(overrides) => void handleMergeConfirm(overrides)}
        />
      )}

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
  disabled = false,
  lockHint = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "date" | "number";
  aiMarked?: boolean;
  disabled?: boolean;
  // When true, show a small lock glyph next to the label (US-1080 eBay-owned).
  lockHint?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className={cn(disabled && "text-muted-foreground")}>
        {label}
        {aiMarked && (
          <span className="ml-1.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
            AI
          </span>
        )}
        {lockHint && (
          <Lock className="ml-1.5 inline h-3 w-3 align-[-1px] text-muted-foreground" />
        )}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
}
