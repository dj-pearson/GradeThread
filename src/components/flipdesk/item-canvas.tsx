import { useEffect, useMemo, useRef, useState } from "react";
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
  EBAY_DEPARTMENT_OPTIONS,
} from "@/lib/constants";
import { deriveGarmentDefaults, deriveGarmentType } from "@/lib/garment-mapping";
import { useEbayReviseListing, type ReviseListingPatch } from "@/hooks/use-ebay";
import { CompEditor } from "@/components/flipdesk/comp-editor";
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import { PhotoManager } from "@/components/flipdesk/photo-manager";
import { MeasurementForm } from "@/components/flipdesk/measurement-form";
import { MeasurementPhotoEditor } from "@/components/flipdesk/measurement-photo-editor";
import { PnlPanel } from "@/components/flipdesk/pnl-panel";
import { MarkListedDialog } from "@/components/flipdesk/mark-listed-dialog";
import { RecordSaleDialog } from "@/components/flipdesk/record-sale-dialog";
import { MergeSkuDialog } from "@/components/flipdesk/merge-sku-dialog";
import { rowToMergeValues, type MergeValues } from "@/lib/merge-values";
import { CategoryCheckCard } from "@/components/flipdesk/category-check-card";
import { FitWidget } from "@/components/fit/fit-widget";
import { EbayCatalogMatchCard } from "@/components/flipdesk/ebay-catalog-match-card";
import { GradeThisItemCard } from "@/components/flipdesk/grade-this-item-card";
import { previewGradingReadiness } from "@/lib/grading-readiness";
import {
  resolveStatus,
  nextAction,
  rankOf,
  type NextActionKind,
} from "@/lib/workflow";
import {
  projectAttributeAspects,
  projectColumnAspects,
} from "@/lib/ebay-prefill";
import type { AspectSourceMap } from "@/lib/aspect-provenance";
import { advanceItemStatus } from "@/lib/status-writer";
import { deriveListingOrigin } from "@/lib/listing-origin";
import {
  changesFromItemDiff,
  syncTitle,
  trimTitleToLimit,
} from "@/lib/title-sync";
import { cn, errorMessage } from "@/lib/utils";
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
  ListingAiSnapshot,
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

// US-821 canonical attributes surfaced as first-class item fields (Details
// section). Values live in inventory_items.attributes; the keys the seller
// edits are projected onto the eBay aspect map on save (projectAttributeAspects)
// the same way the structured columns are — single-entry, no duplicate typing
// in the eBay specifics editor. `clothingOnly` fields hide for categories
// where they'd be noise; `options` feed a datalist (suggestions, not a cage —
// publish-time validation reconciles against eBay's real allowed list).
const ATTRIBUTE_FIELD_DEFS: {
  key: string;
  label: string;
  clothingOnly?: boolean;
  options?: string[];
  multi?: boolean;
  placeholder?: string;
}[] = [
  {
    key: "department",
    label: "Department",
    options: EBAY_DEPARTMENT_OPTIONS.map((o) => o.value),
  },
  {
    key: "size_type",
    label: "Size Type",
    clothingOnly: true,
    options: ["Regular", "Petite", "Plus", "Juniors", "Tall", "Big & Tall", "Maternity"],
  },
  { key: "sleeve_length", label: "Sleeve Length", clothingOnly: true },
  { key: "neckline", label: "Neckline", clothingOnly: true },
  { key: "pattern", label: "Pattern" },
  { key: "fit", label: "Fit", clothingOnly: true },
  { key: "closure", label: "Closure", clothingOnly: true },
  { key: "garment_care", label: "Garment Care", clothingOnly: true },
  { key: "country_of_manufacture", label: "Country of Manufacture" },
  { key: "vintage", label: "Vintage", options: ["Yes", "No"] },
  { key: "theme", label: "Theme" },
  { key: "mpn", label: "MPN" },
  // US-1526: machine-readable identity codes read from the tag photos — hard
  // anchors for product identification/research (US-1527/1528).
  { key: "style_code", label: "Style Code", placeholder: "e.g. LW7DVCS" },
  { key: "rn_number", label: "RN Number", placeholder: "digits after 'RN'" },
  { key: "upc", label: "UPC / EAN", placeholder: "barcode digits" },
  {
    key: "features",
    label: "Features",
    multi: true,
    placeholder: "Pockets, Lined, Hooded — comma-separated",
  },
];

// String-form (editable) view of the attributes jsonb — `features` joins to a
// comma list; everything else passes through.
function attrStringsFrom(
  raw: Record<string, string | string[]> | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of ATTRIBUTE_FIELD_DEFS) {
    const v = raw?.[def.key];
    if (v == null) continue;
    out[def.key] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

// Parse one edited string back to its stored attribute value (null = clear).
function attrValueFrom(
  def: (typeof ATTRIBUTE_FIELD_DEFS)[number],
  s: string,
): string | string[] | null {
  if (def.multi) {
    const arr = s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return arr.length > 0 ? arr : null;
  }
  const t = s.trim();
  return t === "" ? null : t;
}

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
  // US-676 parity: storage location / bin label (e.g. "Tote A3", "Rack 2").
  // Column + items_full view expose it; iOS surfaces it — web had dropped it.
  location_bin: string;
  status: ItemStatus;
  acquired_date: string;
  acquired_price: string;
  target_price: string;
  comp_set: ItemComp[];
  measurements: Record<string, number | string>;
  // US-821 canonical attributes in editable string form (features = comma
  // list). Not on the items_full view — lazy-loaded like color/material.
  attributes: Record<string, string>;
};

// The items_full view exposes `category` as
// COALESCE(item_category::text, garment_category::text) — so an item with no
// item_category but a garment_category (e.g. "pants") surfaces that garment
// value here. Writing it straight back into the item_category ENUM fails with
// 22P02. Only accept a real item_category enum value; a non-empty value that
// isn't one must have fallen back from garment_category, which only exists for
// garments → default to "clothing" (fixes the "pants" save crash + saves the
// user a manual pick).
function normalizeItemCategory(raw: string | null | undefined): ItemCategory | "" {
  if (!raw) return "";
  if ((ITEM_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as ItemCategory;
  }
  return "clothing";
}

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
    item_category: normalizeItemCategory(item.category),
    // garment_type/garment_category aren't on the items_full view — lazy-loaded.
    garment_type: "",
    garment_category: "",
    sourced_by: item.sourced_by ?? "",
    location_bin: item.location_bin ?? "",
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
    // attributes are not in the items_full view — loaded separately.
    attributes: {},
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
  // Baseline for the lazy-loaded US-821 attributes: the raw jsonb (so a save
  // preserves keys this form doesn't surface) + the string form the inputs
  // edit (so persist/buildEbayPatch can tell which keys actually changed).
  const loadedAttrs = useRef<{
    raw: Record<string, string | string[]>;
    strings: Record<string, string>;
  }>({ raw: {}, strings: {} });
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
  // applied. A recognized gender also fills a BLANK Department detail field
  // (never overwriting one the seller set).
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
      if (r.gender && (state.attributes.department ?? "").trim() === "") {
        const dept = EBAY_DEPARTMENT_OPTIONS.find(
          (o) => o.value.toLowerCase() === r.gender!.trim().toLowerCase(),
        );
        if (dept) patchAttr("department", dept.value);
      }
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
      .select(
        "color, material, garment_type, garment_category, attributes, ai_field_sources",
      )
      .eq("id", item.id)
      .single()
      .then(({ data }) => {
        if (cancelled || !data) return;
        const row = data as {
          color: string | null;
          material: string | null;
          garment_type: GarmentType | null;
          garment_category: GarmentCategory | null;
          attributes: Record<string, string | string[]> | null;
          ai_field_sources: ItemFullRow["ai_field_sources"];
        };
        loadedExtras.current = {
          color: row.color ?? "",
          material: row.material ?? "",
        };
        loadedAttrs.current = {
          raw: row.attributes ?? {},
          strings: attrStringsFrom(row.attributes),
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
            attributes: attrStringsFrom(row.attributes),
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
  //
  // Shares the ["item_photos", item.id] cache with PhotoManager/PhotoUploader
  // (same key + shape) so adding/retagging a photo — which invalidates that key
  // — refreshes photo_count/has_required_photos AND the live grading preview
  // below WITHOUT waiting for a save to bump items_full. Fixes the stale
  // "requirements not met" the grade card showed after a retag/detail add.
  // NB: select("*") + order sort_order matches PhotoManager's query for this
  // exact key, so the shared cache entry keeps the full-row shape PhotoManager
  // reads (a slimmer select here would re-cache and break it). We only need
  // photo_type off it.
  const { data: livePhotoRows } = useQuery({
    queryKey: ["item_photos", item.id],
    queryFn: async (): Promise<{ photo_type: string }[]> => {
      const { data, error } = await supabase
        .from("item_photos")
        .select("*")
        .eq("inventory_item_id", item.id)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as { photo_type: string }[];
    },
  });
  const photoTypeSet = useMemo(
    () => new Set((livePhotoRows ?? []).map((r) => r.photo_type)),
    [livePhotoRows],
  );
  useEffect(() => {
    if (!livePhotoRows) return;
    setHeavy((h) => ({
      ...h,
      photo_count: livePhotoRows.length,
      has_required_photos: REQUIRED_PHOTO_TYPES.every((t) =>
        photoTypeSet.has(t),
      ),
    }));
  }, [livePhotoRows, photoTypeSet]);

  // Live grading-readiness preview off the edit form + photo cache, so the
  // "Submit for grading" card flips to Ready the instant the last requirement is
  // met — no save round-trip. Server /submit stays authoritative (doSubmit
  // persists these fields first). See src/lib/grading-readiness.ts.
  const gradingPreview = useMemo(
    () =>
      previewGradingReadiness({
        garment_type: state.garment_type || null,
        garment_category: state.garment_category || null,
        title: state.title,
        photoTypes: photoTypeSet,
      }),
    [state.garment_type, state.garment_category, state.title, photoTypeSet],
  );

  function patch<K extends keyof EditState>(k: K, v: EditState[K]) {
    setState((s) => ({ ...s, [k]: v }));
    setAiFields((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
  }

  function patchAttr(key: string, v: string) {
    setState((s) => ({ ...s, attributes: { ...s.attributes, [key]: v } }));
  }

  // Category coupling: changing item_category re-derives garment_type/
  // garment_category when the coarse FAMILY changes (e.g. clothing → shoes, or a
  // non-garment category), so grading — keyed on item_category + garment_type —
  // stays consistent with the correction. Same-family tweaks keep the seller's
  // garment pick. (The eBay leaf lives in the composer; fixing it there cascades
  // back the other way via ebayPathToItemCategory.)
  function changeItemCategory(next: ItemCategory | "") {
    const prevFamily = deriveGarmentType(state.item_category || null);
    const nextFamily = deriveGarmentType(next || null);
    setState((s) => {
      const patched = { ...s, item_category: next };
      if (nextFamily !== prevFamily) {
        const g = deriveGarmentDefaults(next || null);
        patched.garment_type = g.garment_type ?? "";
        patched.garment_category = g.garment_category ?? "";
      }
      return patched;
    });
    setAiFields((prev) => {
      if (!prev.has("item_category")) return prev;
      const nextSet = new Set(prev);
      nextSet.delete("item_category");
      return nextSet;
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
      location_bin: trimOrNull(s.location_bin),
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

    // US-821 attributes surfaced as first-class fields: persist ONLY the keys
    // the seller edited this session (vs the lazy-loaded baseline), merged over
    // the raw jsonb so keys this form doesn't surface survive. The changed keys
    // also project onto the aspect maps below, alongside the columns.
    const changedAttrs: Record<string, string | string[] | null> = {};
    for (const def of ATTRIBUTE_FIELD_DEFS) {
      const now = (s.attributes[def.key] ?? "").trim();
      const before = (loadedAttrs.current.strings[def.key] ?? "").trim();
      if (now !== before) changedAttrs[def.key] = attrValueFrom(def, now);
    }
    const mergedAttrs: Record<string, string | string[]> = {
      ...loadedAttrs.current.raw,
    };
    if (Object.keys(changedAttrs).length > 0) {
      for (const [k, v] of Object.entries(changedAttrs)) {
        if (v == null) delete mergedAttrs[k];
        else mergedAttrs[k] = v;
      }
      update.attributes = mergedAttrs;
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
    // Attribute edits (Department, Pattern, …) project too — but only the
    // changed keys, so an aspect with no backing attribute isn't touched.
    const invFinal = projectAttributeAspects(
      changedAttrs,
      projected.aspects,
      projected.sources,
    );
    update.ebay_aspects = invFinal.aspects;
    update.ebay_aspect_sources = invFinal.sources;

    const { error } = await supabase
      .from("inventory_items")
      .update(update as never)
      .eq("id", item.id);
    if (error) throw error;

    // Refresh the attribute baseline so a second save in the same session
    // diffs against what's now stored (and doesn't re-apply stale merges).
    if (Object.keys(changedAttrs).length > 0) {
      loadedAttrs.current = {
        raw: mergedAttrs,
        strings: attrStringsFrom(mergedAttrs),
      };
    }

    // Keep the per-listing canonical copy (listings.item_specifics_override, which
    // publish reads FIRST) in lockstep with the inventory mirror — otherwise a
    // drafted listing would keep serving the stale override at publish time.
    if (item.listing_id) {
      const { data: lstRaw } = await supabase
        .from("listings")
        .select(
          "item_specifics_override, item_specifics_sources, listing_title, listing_description, listing_price, title_variants, ai_generated_snapshot",
        )
        .eq("id", item.listing_id)
        .maybeSingle();
      const lstRow = lstRaw as {
        item_specifics_override: Record<string, string[]> | null;
        item_specifics_sources: AspectSourceMap | null;
        listing_title: string | null;
        listing_description: string | null;
        listing_price: number | null;
        title_variants: Array<{ label?: string; title?: string; active?: boolean }> | null;
        ai_generated_snapshot: ListingAiSnapshot | null;
      } | null;
      const lp = projectColumnAspects(
        columnFields,
        lstRow?.item_specifics_override ?? {},
        lstRow?.item_specifics_sources ?? {},
      );
      const lpFinal = projectAttributeAspects(changedAttrs, lp.aspects, lp.sources);
      const listingUpdate: Record<string, unknown> = {
        item_specifics_override: lpFinal.aspects,
        item_specifics_sources: lpFinal.sources,
      };
      // Smart-merge draft title/description/price. A DRAFT listing snapshots
      // these at draft time, and publish reads `listing.X ?? item.X`, so a later
      // canvas edit was silently SHADOWED at publish. Propagate the canvas edit
      // to the draft ONLY when the seller hasn't customized that field in the
      // composer (the draft still holds the item's prior value, or nothing) — so
      // an eBay-optimized title/price the seller set in the composer is never
      // clobbered. Live listings sync through the revise path instead (isGtLive).
      if (!isGtLive) {
        const newTitle = s.title.trim() || item.item_title;
        const draftTitle = (lstRow?.listing_title ?? "").trim();
        if (
          newTitle &&
          (draftTitle === "" || draftTitle === (item.item_title ?? "").trim())
        ) {
          listingUpdate.listing_title = newTitle;
        }
        const draftDesc = (lstRow?.listing_description ?? "").trim();
        if (
          draftDesc === "" ||
          draftDesc === (item.item_description ?? "").trim()
        ) {
          listingUpdate.listing_description = trimOrNull(s.description);
        }
        const newPrice = priceOrNull(s.target_price);
        const draftPrice = lstRow?.listing_price ?? null;
        if (
          newPrice != null &&
          newPrice > 0 &&
          (draftPrice == null || draftPrice === item.target_price)
        ) {
          listingUpdate.listing_price = newPrice;
        }
      }
      // US-1891: backwards title sync. When the seller corrects a searchable
      // field (brand/size/color/style/department), substitute it into the
      // listing TITLE too — the one field buyers search hardest, which nothing
      // else rebuilds. Never touch an eBay-origin mirror (sync-precedence guard).
      const titleFieldChanges = changesFromItemDiff(
        {
          brand: item.brand,
          size: item.size,
          color: item.color,
          style: item.style,
          department: loadedAttrs.current.strings.department,
        },
        {
          brand: s.brand,
          size: s.size,
          color: s.color,
          style: s.style,
          department: s.attributes.department,
        },
      );
      if (!lockedByEbay && titleFieldChanges.length > 0) {
        // Sync the title as it will stand after the draft smart-merge above.
        const baseTitle =
          (typeof listingUpdate.listing_title === "string"
            ? listingUpdate.listing_title
            : null) ??
          lstRow?.listing_title ??
          item.item_title ??
          "";
        const syncedTitle = syncTitle(baseTitle, titleFieldChanges);
        if (syncedTitle && syncedTitle !== trimTitleToLimit(baseTitle)) {
          listingUpdate.listing_title = syncedTitle;
          // AC4: both A/B title variants get the substitution.
          const variants = lstRow?.title_variants;
          if (Array.isArray(variants)) {
            listingUpdate.title_variants = variants.map((v) =>
              v && typeof v.title === "string"
                ? { ...v, title: syncTitle(v.title, titleFieldChanges) }
                : v,
            );
          }
          // AC2/AC3: a hand-edited title (diverged from the AI snapshot) or a
          // LIVE GradeThread listing flags needs_review — the composer surfaces
          // the diff chip / "listing out of date — push update" prompt (which
          // uses the revise-in-place path; never an auto end/relist).
          const snapTitle = (lstRow?.ai_generated_snapshot?.title ?? "").trim();
          const handEdited = snapTitle !== "" &&
            trimTitleToLimit(baseTitle) !== trimTitleToLimit(snapTitle);
          if (handEdited || isGtLive) listingUpdate.needs_review = true;
        }
      }
      await supabase
        .from("listings")
        .update(listingUpdate as never)
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
      state.condition_notes.trim() !== (item.notes ?? "").trim() ||
      // US-821 attributes feed the eBay specifics too (Department, Pattern, …)
      // — an edit must trigger the inventory re-PUT like a column edit does.
      ATTRIBUTE_FIELD_DEFS.some(
        (d) =>
          (state.attributes[d.key] ?? "").trim() !==
          (loadedAttrs.current.strings[d.key] ?? "").trim(),
      );
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
      // supabase-js rejects with a PostgrestError plain object, so read code +
      // message + details directly (the constraint name can land in either).
      const pgErr = err as {
        code?: string;
        message?: string;
        details?: string;
      };
      const sku = state.sku.trim();
      const dupText = `${pgErr.message ?? ""} ${pgErr.details ?? ""}`;
      const isSkuDuplicate =
        pgErr.code === "23505" &&
        !!sku &&
        (dupText.includes("idx_inventory_items_user_sku") ||
          dupText.toLowerCase().includes("sku"));
      if (isSkuDuplicate) {
        // Load the row that already owns this SKU so the merge dialog can show
        // its fields. `.limit(1)` (not `.maybeSingle()`) so a stray >1-row data
        // state can't itself throw and mask the duplicate.
        const { data, error: lookupErr } = await supabase
          .from("inventory_items")
          .select("*")
          .eq("user_id", item.user_id)
          .eq("sku", sku)
          .neq("id", item.id)
          .order("updated_at", { ascending: false })
          .limit(1);
        const existing = (data ?? [])[0] as InventoryItemRow | undefined;
        if (existing) {
          setMergeExisting(existing);
          return;
        }
        // The index says the SKU is taken, but we couldn't load the other row
        // (RLS, a filter, or it was just deleted). Tell the user plainly rather
        // than dead-ending on a raw Postgres string.
        toast.error(
          `SKU "${sku}" is already used by another item in your inventory. ` +
            (lookupErr
              ? "It couldn't be loaded to merge — refresh and try again."
              : "Pick a different SKU, or open that item to merge them."),
        );
        return;
      }
      toast.error(`Save failed: ${errorMessage(err)}`);
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
          `Records merged, but saving your field choices failed: ${errorMessage(
            persistErr,
          )}. Review the item and save again.`,
        );
      }
    } catch (err) {
      toast.error(`Merge failed: ${errorMessage(err)}`);
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
      toast.error(`Duplicate failed: ${errorMessage(err)}`);
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
      toast.error(`Relist failed: ${errorMessage(err)}`);
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
      toast.error(`Failed: ${errorMessage(err)}`);
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
                changeItemCategory(v === "__none" ? "" : (v as ItemCategory))
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
            label="Location / Bin"
            value={state.location_bin}
            onChange={(v) => patch("location_bin", v)}
          />
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

        <div id="canvas-details" className="space-y-2 scroll-mt-4">
          <div className="flex items-center gap-2">
            <Label>Details</Label>
            {/* US-1528: the research identification was cross-referenced
                against live eBay listings in the background and confirmed. */}
            {loadedAttrs.current.raw.identification_verified === "true" && (
              <Badge
                variant="outline"
                className="border-green-200 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300"
                title={
                  Array.isArray(loadedAttrs.current.raw.market_title_keywords) &&
                  loadedAttrs.current.raw.market_title_keywords.length > 0
                    ? `Market keywords: ${(loadedAttrs.current.raw.market_title_keywords as string[]).join(", ")}`
                    : undefined
                }
              >
                Verified on eBay
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Optional specifics — Department, Pattern, and friends. Entered once
            here they flow straight into the eBay item specifics (and edits
            there sync back), so nothing is typed twice.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ATTRIBUTE_FIELD_DEFS.filter(
              (d) => !d.clothingOnly || state.item_category === "clothing",
            ).map((d) => (
              <AttributeField
                key={d.key}
                fieldKey={d.key}
                label={d.label}
                value={state.attributes[d.key] ?? ""}
                options={d.options}
                placeholder={d.placeholder}
                onChange={(v) => patchAttr(d.key, v)}
              />
            ))}
          </div>
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
          {/* US-1574: calibrated photo measuring (shows only with a
              MeasureCard shot on the item). */}
          <MeasurementPhotoEditor
            itemId={item.id}
            category={item.category}
            values={state.measurements}
            aiSources={heavy.ai_field_sources}
            onApply={(next) => patch("measurements", next)}
          />
          {/* US-1779: buyer fit preview from these flat-lay measurements vs the
              viewer's saved body profile (renders only when measurements exist). */}
          <FitWidget garmentMeasurements={state.measurements} category={item.category} />
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
          <GradeThisItemCard
            item={item}
            preview={gradingPreview}
            liveFields={{
              title: state.title,
              garment_type: state.garment_type,
              garment_category: state.garment_category,
            }}
            onPatchGarment={(gt, gc) => {
              patch("garment_type", gt);
              patch("garment_category", gc);
            }}
          />
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

// One US-821 attribute input — free text with option suggestions (datalist),
// so eBay's common values are one click away without blocking rarer ones.
function AttributeField({
  fieldKey,
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  fieldKey: string;
  label: string;
  value: string;
  options?: string[];
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const listId =
    options && options.length > 0 ? `attr-options-${fieldKey}` : undefined;
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder={placeholder}
      />
      {listId && (
        <datalist id={listId}>
          {options!.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </div>
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
