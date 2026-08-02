import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Save,
  Loader2,
  Award,
  Rocket,
  Sparkles,
  Store,
  BadgeCheck,
  AlertTriangle,
  CalendarClock,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  detectTimezone,
  formatInZone,
} from "@/lib/scheduling";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useItemFull } from "@/hooks/use-items-full";
import { useSellerPromoDefaults } from "@/hooks/use-seller-promo-defaults";
import { useMeasurementPrefs } from "@/stores/measurement-prefs";
import {
  DESCRIPTION_TEMPLATES,
  ensureGradeLine,
  ensureSellerCredentials,
  interpolateDescription,
  splitSellerCredentials,
  templateGroupFor,
  titleKeywords,
} from "@/lib/listing-templates";
import { titleQuality } from "@/lib/title-quality";
import {
  EBAY_CONDITION_OPTIONS,
  ITEM_CATEGORIES,
  ITEM_STATUS_LABELS,
  MARKETPLACE_LABELS,
  MARKETPLACE_TIER,
  type CrossListingPlatform,
  isNonListablePhotoType,
} from "@/lib/constants";
import { resolveStatus, factsOf, nextAction } from "@/lib/workflow";
import { errorMessage, isoToLocalInput, localInputToIso } from "@/lib/utils";
import { estimateListingProfit } from "@/lib/listing-profit";
import { COMPOSER_FOCUS_ANCHORS } from "@/lib/publish-blockers";
import {
  mapEbayCondition,
  projectColumnAspectsForSpec,
  reverseProjectAspectColumns,
  syncedItemFieldFor,
  type AspectWriteBack,
  type ItemAspectSource,
} from "@/lib/ebay-prefill";
import { deriveListingOrigin } from "@/lib/listing-origin";
import { ebayPathToItemCategory } from "@/lib/ebay-category-map";
import { previewGradingReadiness } from "@/lib/grading-readiness";
import { garmentPatchForCategoryChange } from "@/lib/garment-mapping";
import { planEbayPrepRefresh } from "@/lib/ai-ebay-prep";
import type { AspectSourceMap } from "@/lib/aspect-provenance";
import { EbayCatalogMatchCard } from "@/components/flipdesk/ebay-catalog-match-card";
import { CategoryCheckCard } from "@/components/flipdesk/category-check-card";
import { GradeThisItemCard } from "@/components/flipdesk/grade-this-item-card";
import {
  AiFillPanel,
  type AcceptedField,
} from "@/components/flipdesk/ai-fill-panel";
import {
  useAiRewrite,
  type AiExtractResponse,
  type RewriteAction,
} from "@/hooks/use-ai-extract";
import {
  conditionLabel,
} from "@/lib/listing-ai-diff";
import {
  centsToDollarInput,
  dollarInputToCents,
  resolveBestOfferThresholds,
} from "@/lib/best-offer-thresholds";
import { EbayCompsPanel } from "@/components/flipdesk/ebay-comps-panel";
import { PublishToEbayDialog } from "@/components/flipdesk/publish-to-ebay-dialog";
import { ListingKit } from "@/components/flipdesk/listing-kit";
import { EbayViewItemPreview } from "@/components/flipdesk/ebay-view-item-preview";
import {
  ListingFormatControls,
  type ListingFormatValue,
} from "@/components/flipdesk/listing-format-controls";
import {
  useEbayCategoryAspects,
  useEbayCategoryConditions,
  useEbayConnection,
  useEbayPolicies,
  useEbayReviseListing,
  useMigrateEbayListings,
  useRecommendedCoverage,
} from "@/hooks/use-ebay";
import { useCrossPush } from "@/hooks/use-cross-listing";
import { useSellThroughForecast } from "@/hooks/use-forecast";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import type {
  ItemCategory,
  ItemPhotoRow,
  ItemStatus,
  ListingRow,
} from "@/types/database";
import { MergeSkuDialog } from "@/components/flipdesk/merge-sku-dialog";
import { RecordSaleDialog } from "@/components/flipdesk/record-sale-dialog";
import { ItemDetailsCard } from "@/components/flipdesk/composer/item-details-card";
import { StorageSkuCard } from "@/components/flipdesk/composer/storage-sku-card";
import { PhotosCard } from "@/components/flipdesk/composer/photos-card";
import { MeasurementsCard } from "@/components/flipdesk/composer/measurements-card";
import { TitleCard } from "@/components/flipdesk/composer/title-card";
import { SpecificsSection } from "@/components/flipdesk/composer/specifics-section";
import { PriceCard } from "@/components/flipdesk/composer/price-card";
import { CostMarginCard } from "@/components/flipdesk/composer/cost-margin-card";
import { PoliciesCard } from "@/components/flipdesk/composer/policies-card";
import { PromoteCard } from "@/components/flipdesk/composer/promote-card";
import { DescriptionCard } from "@/components/flipdesk/composer/description-card";
import { PushToCard } from "@/components/flipdesk/composer/push-to-card";
import { ScheduleCard } from "@/components/flipdesk/composer/schedule-card";
import { useSkuMerge } from "@/hooks/use-sku-merge";
import { WorkflowActionsCard } from "@/components/flipdesk/composer/workflow-actions-card";
import { MarkListedDialog } from "@/components/flipdesk/mark-listed-dialog";
import { useAiExtract, useAiSizeEstimate } from "@/hooks/use-ai-extract";
// US-2248/US-2249: the save payloads live in one pure module so the draft and
// live paths cannot drift apart again (see src/lib/composer-save.ts).
import {
  buildDraftListingPayload,
  buildLiveListingPatch,
  buildItemPatch,
  resolveQuantity,
  TITLE_MAX,
  type ComposerListingState,
} from "@/lib/composer-save";


// Legacy rows can carry a coarse category string that predates ITEM_CATEGORIES.
// Anything unrecognized is clothing (the only vertical FlipDesk shipped with).
function normalizeItemCategory(raw: string | null | undefined): ItemCategory | "" {
  if (!raw) return "";
  if ((ITEM_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as ItemCategory;
  }
  return "clothing";
}

// Stable identity for the photos query's pending/empty state. An inline `[]`
// default is a NEW array every render, and the drag-order sync effect
// (`setOrder(photos)`) keys on the array's identity — with a fresh identity
// each render, that effect re-fires each render and each setOrder schedules
// another render: an update loop that runs until the query resolves. On a
// slow load React hits its nested-update limit first and the route crashes
// with "Maximum update depth exceeded" (the AutoLister drafts → Review error
// page). One shared constant makes the pending identity stable.
const EMPTY_PHOTOS: ItemPhotoRow[] = [];

// US-568: composer default — fixed-price, no auction terms, single SKU.
const DEFAULT_LISTING_FORMAT_VALUE: ListingFormatValue = {
  format: "fixed_price",
  auctionStartPrice: "",
  auctionReservePrice: "",
  auctionBuyItNowPrice: "",
  auctionDuration: "DAYS_7",
  variations: null,
};

// Shared item specifics whose value the buyer expects to also see reflected in
// the free-text description. Item specifics and the description are edited on
// independent tracks (changing one never rewrites the other), so a changed
// specific can silently disagree with a stale description — the pre-push
// reminder below catches exactly that. Keep to fields a buyer reads in prose;
// e.g. "US Shoe Size" maps to `size`, "Colour" to `color`, via syncedItemFieldFor.
const SHARED_DESC_FIELDS = ["brand", "size", "color", "material"] as const;
type SharedDescField = (typeof SHARED_DESC_FIELDS)[number];
const SHARED_FIELD_LABELS: Record<SharedDescField, string> = {
  brand: "Brand",
  size: "Size",
  color: "Color",
  material: "Material",
};

// Collapse an eBay aspect map down to the {brand,size,color,material} values it
// carries (first non-empty value per field), resolving category-specific aspect
// names via the shared registry. Used to diff the saved specifics against the
// live-edited ones without depending on category-specific aspect naming.
function sharedValuesFromAspects(
  aspects: Record<string, string[]> | null | undefined,
  category: string | null,
): Partial<Record<SharedDescField, string>> {
  const out: Partial<Record<SharedDescField, string>> = {};
  if (!aspects) return out;
  for (const [name, vals] of Object.entries(aspects)) {
    const field = syncedItemFieldFor(name, category);
    if (!field || !(SHARED_DESC_FIELDS as readonly string[]).includes(field)) {
      continue;
    }
    const key = field as SharedDescField;
    if (out[key]) continue;
    const v = (vals ?? []).map((x) => x.trim()).find((x) => x.length > 0);
    if (v) out[key] = v;
  }
  return out;
}

// Whole-word, case-insensitive presence check — so a Size of "M" matches "size M"
// but not "Medium"/"maroon", and "Nike" matches only as its own word.
function descriptionMentions(description: string, value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`, "i").test(description);
}

// One editor, every status. This page is the single item/listing editor behind
// /dashboard/flipdesk/items/:id — the old split (composer for drafts, ItemCanvas
// for everything else) meant an item that went live lost the eBay category +
// item-specifics editor, so a save on a listed item pushed an incomplete
// specifics map and eBay bounced it ("The item specific Department is missing").
// `itemId` lets a host (the item page, the detail sheet) mount the same editor
// without a route; `showHeader={false}` suppresses the back-arrow header when
// that host already renders one.
export function FlipdeskComposerPage({
  itemId,
  showHeader = true,
  onDirtyChange,
}: {
  itemId?: string;
  showHeader?: boolean;
  /**
   * US-2256: reported whenever the form's unsaved state changes. A host that can
   * dismiss this editor WITHOUT navigating — the item detail dialog, the quick-look
   * sheet — has to run its own confirm, because React Router's blocker only sees
   * route changes and a closing dialog isn't one.
   */
  onDirtyChange?: (dirty: boolean) => void;
} = {}) {
  const { id: routeId } = useParams<{ id: string }>();
  const id = itemId ?? routeId;
  const navigate = useNavigate();
  const qc = useQueryClient();
  // US-827/US-648: render description measurements in the seller's unit.
  const measurementUnit = useMeasurementPrefs((s) => s.unit);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ebayCondition, setEbayCondition] = useState("");
  const [conditionDesc, setConditionDesc] = useState("");
  const [price, setPrice] = useState("");
  // What you PAID for the item (inventory_items.acquired_price). Lives on the
  // item, not the listing, but it's edited here because this is where the
  // margin decision gets made — the profit panel below was telling sellers to
  // "add this item's cost" with nowhere in the composer to add it.
  const [cost, setCost] = useState("");
  const [priceEstimated, setPriceEstimated] = useState(false);
  // US-542: which comp source produced the price (active_asking warrants a
  // distinct caveat — asking prices, not realized sales).
  const [priceCompSource, setPriceCompSource] = useState<string | null>(null);
  const [scheduledAt, setScheduledAt] = useState("");
  // US-563: timezone the drop presets are evaluated in (peak buying times are
  // local, e.g. "Sunday 7 PM" in the seller's market). Defaults to the viewer's
  // own zone; the <input type="datetime-local"> stays browser-local, so a preset
  // just computes the UTC instant and fills the input with its local equivalent.
  const [dropTimezone, setDropTimezone] = useState(() => detectTimezone());
  const [primaryPhotoId, setPrimaryPhotoId] = useState<string | null>(null);
  // US-1567: measurements are editable right in the composer (parity with the
  // item canvas) — they feed the category's measurement aspects at publish.
  const [measurements, setMeasurements] = useState<
    Record<string, number | string>
  >({});
  // Item-level logistics (SKU / storage location / container), editable here for
  // parity with the iOS item canvas so the seller can label & locate the
  // physical item while drafting. These save to inventory_items (not the eBay
  // listing) via their own Save button, independent of the draft/publish flow.
  const [storageSku, setStorageSku] = useState("");
  const [storageLocation, setStorageLocation] = useState("");
  const [storageContainer, setStorageContainer] = useState("");
  // Item-level bookkeeping that used to live only on the retired ItemCanvas.
  // These are inventory_items columns, saved by the same single Save as the
  // listing fields — the whole point of one editor is that nothing is stranded
  // on a surface you can only reach at one status.
  const [itemStatus, setItemStatus] = useState<ItemStatus>("sourced");
  const [itemCategory, setItemCategory] = useState<ItemCategory | "">("");
  // Tracks whether the seller picked the coarse category by hand this session.
  // If they did, it wins over the eBay-category cascade (which would otherwise
  // silently overwrite the deliberate pick in the same save).
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [sourcedBy, setSourcedBy] = useState("");
  const [acquiredDate, setAcquiredDate] = useState("");
  // US-2260: recording the sale is what makes an item sold — offered here instead
  // of letting the status dropdown claim it without the money behind it.
  const [recordSaleOpen, setRecordSaleOpen] = useState(false);
  // US-2264: the workflow actions ported off the unmounted ItemCanvas.
  const [markListedOpen, setMarkListedOpen] = useState(false);
  const [aiFillResult, setAiFillResult] = useState<AiExtractResponse | null>(
    null,
  );
  const [aiFillOpen, setAiFillOpen] = useState(false);
  const aiExtract = useAiExtract();
  const sizeAi = useAiSizeEstimate();
  // US-561: Promoted Listings. promoteEnabled mirrors !promo_opt_out (promote by
  // default); promoRate is the seller's accepted/adjusted ad rate (%) seeded
  // from the category suggestion; promoSuggested holds the fetched suggestion so
  // the seller can revert to it.
  const [promoteEnabled, setPromoteEnabled] = useState(true);
  const [promoRate, setPromoRate] = useState("");
  const [promoSuggested, setPromoSuggested] = useState<number | null>(null);
  // US-1447: Promoted Listings mode — 'cps' (Cost-Per-Sale %, default), 'cpc'
  // (Cost-Per-Click / Priority; bid is eBay's ad-group max-CPC, no % applies),
  // or 'smart' (Smart Targeting — eBay auto-targets under a suggested max-CPC).
  const [promoMode, setPromoMode] = useState<"cps" | "cpc" | "smart">("cps");
  // US-568: listing format (fixed/auction), auction terms, and variation matrix.
  const [listingFormat, setListingFormat] = useState<ListingFormatValue>(
    DEFAULT_LISTING_FORMAT_VALUE,
  );
  // US-1898: Best Offer toggle + auto-accept/auto-decline (dollar strings; blank
  // falls back to the comp-derived default at save). Persisted to best_offer_*.
  const [bestOfferEnabled, setBestOfferEnabled] = useState(false);
  const [bestOfferAccept, setBestOfferAccept] = useState("");
  const [bestOfferDecline, setBestOfferDecline] = useState("");
  // US-2250: how many of this item are for sale. listings.quantity was already
  // read at publish and settable from AutoLister bulk-edit, but the single-item
  // composer had no field — so a seller with five identical tees had to create
  // five items. Auctions and variation matrices override it (resolveQuantity).
  const [quantity, setQuantity] = useState("1");
  // US-2382: no badgeEnabled / slabImageMode state here on purpose. US-2247
  // added both on the premise that "publish reads listings.badge_enabled /
  // slab_image_mode" — publish SELECTS them, which is not the same thing, and
  // nothing ever branched on either. The switch was removed rather than wired,
  // because a grade card in the gallery is still a listing photo bearing a
  // third-party grading mark (grade-authority-on-listings.md).
  // US-2251: per-listing eBay business policies. null = fall back to the
  // account default, which is exactly what publish does when these are NULL.
  const [shippingPolicyId, setShippingPolicyId] = useState<string | null>(null);
  const [paymentPolicyId, setPaymentPolicyId] = useState<string | null>(null);
  const [returnPolicyId, setReturnPolicyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [initialised, setInitialised] = useState(false);
  // US-2256: a serialized snapshot of every editable field as it was seeded (and
  // re-stamped after each successful save). Anything other than a byte-identical
  // match means there is unsaved work worth warning about. null until seeding
  // completes, so a still-loading form can never look dirty.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  // Lifted from the category picker so the comps panel reacts to a pick
  // before the user commits via "Save eBay specifics".
  const [livePickedCategoryId, setLivePickedCategoryId] = useState<
    string | null
  >(null);
  // The breadcrumb path of the eBay category the seller just picked, so a save
  // can derive the coarse item_category from it (category coupling). Null until
  // they change the category this session.
  const [livePickedCategoryPath, setLivePickedCategoryPath] = useState<
    string | null
  >(null);
  // US-557: the aspect map lifted out of the category picker. The picker no
  // longer has its own Save — saveDraft is the single Save that writes these to
  // BOTH the listing override and the inventory mirror, so aspect edits can't
  // silently vanish. null = the picker hasn't reported yet (fall back to the
  // saved values on save).
  const [livePickedAspects, setLivePickedAspects] = useState<
    Record<string, string[]> | null
  >(null);
  // US-825: live provenance map + required-but-unfilled names lifted from the
  // picker. The single Save persists the sources; the publish button uses the
  // missing list to warn inline (same required-aspect rule the server blocks on).
  const [livePickedSources, setLivePickedSources] =
    useState<AspectSourceMap | null>(null);
  const [missingRequired, setMissingRequired] = useState<string[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  // US-552: inline AI rewrite — the in-flight action (for the spinner) and the
  // result fed into AiFillPanel for review/accept.
  const [rewriteAction, setRewriteAction] = useState<RewriteAction | null>(null);
  const [rewriteResult, setRewriteResult] = useState<AiExtractResponse | null>(
    null,
  );
  const [rewritePanelOpen, setRewritePanelOpen] = useState(false);
  const aiRewrite = useAiRewrite();
  // US-149: multi-marketplace "Push to" picks + per-platform price overrides
  // (string-typed like the main price input; blank = use the main price).
  const [pushPlatforms, setPushPlatforms] = useState<Set<CrossListingPlatform>>(
    () => new Set<CrossListingPlatform>(["ebay"]),
  );
  const [platformPrices, setPlatformPrices] = useState<
    Partial<Record<CrossListingPlatform, string>>
  >({});
  const { data: ebayConnection } = useEbayConnection();
  // US-558: the seller's business policies feed the preview's shipping/returns
  // lines. Only fetch once eBay is connected.
  const { data: ebayPolicies } = useEbayPolicies(!!ebayConnection);
  const crossPush = useCrossPush();
  // US-1490: push edits to an ALREADY-published eBay listing (Save & resubmit).
  const reviseListing = useEbayReviseListing();
  // 00432: seller's Promoted-Listings defaults — seed the promote toggle/rate/
  // mode when this listing has no explicit choice yet (off by default, opt-in).
  const { data: promoDefaults, isLoading: promoDefaultsLoading } =
    useSellerPromoDefaults();

  // US-2188: one row, not the whole catalog. The editor renders exactly one
  // item, so it reads exactly one — everything that lists items now shares the
  // projected read instead (useItemsList).
  const { data: item = null, isLoading } = useItemFull(id);

  // Duplicate-SKU recovery lives in its own hook: ANY save that writes a SKU can
  // hit the (user_id, sku) index, and the useful answer is almost never "pick a
  // different SKU" — it is "you scanned the same garment twice, merge them".
  const skuMerge = useSkuMerge(item);

  // US-1895: recommended-aspect coverage for the composer meter (edge single
  // source). Refetched when its key is invalidated after an aspect save below.
  const { data: aspectCoverage } = useRecommendedCoverage(item?.id);

  // US-954: when arriving from an AutoLister pre-flight blocker deep-link
  // (`?focus=<field>`), scroll the offending field into view and focus it once
  // the editor has mounted, so the seller lands directly on what to fix.
  const [focusParams] = useSearchParams();
  useEffect(() => {
    if (isLoading || !item) return;
    const focus = focusParams.get("focus");
    if (!focus) return;
    const anchorId = COMPOSER_FOCUS_ANCHORS[focus];
    if (!anchorId) return;
    // Defer a tick so the target has painted (the category section seeds behind
    // its own loading skeleton).
    const t = setTimeout(() => {
      const el = document.getElementById(anchorId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        el.focus({ preventScroll: true });
      }
    }, 120);
    return () => clearTimeout(t);
  }, [isLoading, item, focusParams]);

  const { data: photos = EMPTY_PHOTOS, isLoading: photosLoading } = useQuery({
    queryKey: ["item_photos", id],
    enabled: !!id,
    queryFn: async (): Promise<ItemPhotoRow[]> => {
      const { data, error } = await supabase
        .from("item_photos")
        .select("*")
        .eq("inventory_item_id", id!)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ItemPhotoRow[];
    },
  });

  // The most-recent listing row, when one exists — seeds the saved picks.
  const { data: listing = null, isLoading: listingLoading } = useQuery({
    queryKey: ["listing", item?.listing_id],
    enabled: !!item?.listing_id,
    queryFn: async (): Promise<ListingRow | null> => {
      const { data, error } = await supabase
        .from("listings")
        .select("*")
        .eq("id", item!.listing_id!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as ListingRow | null;
    },
  });

  // eBay taxonomy mapping lives on inventory_items (added in 00030), which
  // isn't exposed through the items_full view. Fetch it on the side so the
  // composer can render the eBay category picker. color/material ride along
  // (also missing from items_full) to feed the aspect prefill.
  const { data: ebayMapping = null, isLoading: ebayMappingLoading } = useQuery({
    queryKey: ["inventory_item_ebay", id],
    enabled: !!id,
    queryFn: async (): Promise<{
      ebay_category_id: string | null;
      ebay_aspects: Record<string, string[]> | null;
      ebay_aspect_sources: AspectSourceMap | null;
      ai_generated_aspects_at: string | null;
      color: string | null;
      material: string | null;
      attributes: Record<string, string | string[]> | null;
      // For the category coupling: the real coarse category + grading axis, so a
      // save cascades a corrected eBay category to them only when they'd change.
      item_category: string | null;
      garment_type: string | null;
      garment_category: string | null;
    } | null> => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select(
          "ebay_category_id, ebay_aspects, ebay_aspect_sources, ai_generated_aspects_at, color, material, attributes, item_category, garment_type, garment_category",
        )
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as {
        ebay_category_id: string | null;
        ebay_aspects: Record<string, string[]> | null;
        ebay_aspect_sources: AspectSourceMap | null;
        ai_generated_aspects_at: string | null;
        color: string | null;
        material: string | null;
        attributes: Record<string, string | string[]> | null;
        item_category: string | null;
        garment_type: string | null;
        garment_category: string | null;
      } | null;
    },
  });

  // US-2245: the brand's own product code off the tag. Comps searched on it come
  // back as the SAME garment, so the pricing panel tries it before the title.
  // style_code first, mpn as fallback — extraction fills both when one printed
  // code serves both roles.
  const compStyleCode = useMemo(() => {
    const attrs = ebayMapping?.attributes ?? null;
    for (const key of ["style_code", "mpn"] as const) {
      const raw = attrs?.[key];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  }, [ebayMapping?.attributes]);

  // Live grading-readiness preview for the drafts-editor grade card, so it flips
  // to Ready the instant the last requirement is met (photos are DB-immediate;
  // title is composer state; garment comes from the item). Mirrors the item
  // canvas — see src/lib/grading-readiness.ts.
  const gradingPreview = useMemo(
    () =>
      previewGradingReadiness({
        garment_type: ebayMapping?.garment_type ?? null,
        garment_category: ebayMapping?.garment_category ?? null,
        title,
        photoTypes: new Set(photos.map((p) => p.photo_type)),
      }),
    [
      ebayMapping?.garment_type,
      ebayMapping?.garment_category,
      title,
      photos,
    ],
  );

  // Structured item columns the aspect prefill can draw from — memoized so the
  // picker's seed effect doesn't churn on every render. Live measurements are
  // included so category remap fill-only uses current composer values; the
  // picker's remap key deliberately ignores measurement-only churn.
  const itemAspectSource = useMemo<ItemAspectSource | null>(
    () =>
      item
        ? {
            title: item.item_title,
            brand: item.brand,
            size: item.size,
            color: ebayMapping?.color ?? null,
            material: ebayMapping?.material ?? null,
            style: item.style,
            description: item.item_description,
            condition_notes: item.notes,
            item_category: item.category,
            attributes: ebayMapping?.attributes ?? null,
            // Live Measurements state — fill-only fold on category remap, plus
            // the picker's dedicated live last-write-wins bridge.
            measurements:
              Object.keys(measurements).length > 0 ? measurements : null,
          }
        : null,
    [item, ebayMapping, measurements],
  );

  // Seed editable fields once the item, photos, and listing have settled.
  // Everything the item already knows is carried in (description, condition
  // notes, grade-derived condition, target price) so the composer never asks
  // the user to re-enter data — they review and adjust instead.
  useEffect(() => {
    if (initialised || !item) return;
    if (item.listing_id && !listing) return; // wait for the listing fetch
    if (promoDefaultsLoading) return; // wait for the seller promote default
    // Wait for photos too — seeding primary_photo_id against an empty (still-
    // loading) set would seed null and Save would WIPE the saved primary photo.
    if (photosLoading) return;
    setTitle(
      (listing?.listing_title ?? item.item_title ?? "").slice(0, TITLE_MAX),
    );
    setDescription(listing?.listing_description ?? item.item_description ?? "");
    // Same fallback publish applies server-side: explicit listing value, else
    // grade-derived mapping — surfaced here so it's visible and editable.
    setEbayCondition(
      listing?.ebay_condition ??
        mapEbayCondition(item.grade_value, item.grade_label),
    );
    setConditionDesc(listing?.ebay_condition_description ?? item.notes ?? "");
    // First POSITIVE price wins — a stale 0 on a draft listing row must not
    // shadow the item's target price.
    const seedPrice =
      [listing?.listing_price, item.target_price, item.list_price].find(
        (p): p is number => p != null && p > 0,
      ) ?? null;
    setPrice(seedPrice != null ? String(seedPrice) : "");
    setCost(item.purchase_price != null ? String(item.purchase_price) : "");
    setPriceEstimated(listing?.price_is_estimated ?? false);
    setPriceCompSource(listing?.price_comp_source ?? null);
    setScheduledAt(isoToLocalInput(listing?.scheduled_publish_at ?? null));
    // 00432: promotion is off by default, opt-in per seller. Seed the toggle from
    // this listing's explicit override, else the seller default. Mode/rate seed
    // from the listing, else the seller default; the suggestion effect fills the
    // rate from the category once resolved (when neither has a saved value).
    setPromoteEnabled(
      listing?.promote_override ??
        promoDefaults?.promote_listings_by_default ??
        false,
    );
    const seedMode = listing?.promo_mode ?? promoDefaults?.default_promo_mode;
    setPromoMode(
      seedMode === "cpc" || seedMode === "smart" ? seedMode : "cps",
    );
    setPromoRate(
      listing?.promo_rate_pct != null
        ? String(listing.promo_rate_pct)
        : promoDefaults?.default_promo_rate_pct != null
          ? String(promoDefaults.default_promo_rate_pct)
          : "",
    );
    // US-568: seed listing format + auction terms + variation matrix.
    const centsToStr = (c: number | null | undefined) =>
      typeof c === "number" && c > 0 ? String(c / 100) : "";
    setListingFormat({
      format: listing?.listing_format === "auction" ? "auction" : "fixed_price",
      auctionStartPrice: centsToStr(listing?.auction_start_price_cents),
      auctionReservePrice: centsToStr(listing?.auction_reserve_price_cents),
      auctionBuyItNowPrice: centsToStr(listing?.auction_buy_it_now_price_cents),
      auctionDuration: listing?.auction_duration ?? "DAYS_7",
      variations: listing?.variations ?? null,
    });
    // US-1898: seed Best Offer from the saved listing; leave the inputs blank
    // so they show the comp-derived default (filled in on enable / at save).
    setBestOfferEnabled(listing?.best_offer_enabled ?? false);
    setBestOfferAccept(centsToDollarInput(listing?.best_offer_auto_accept_cents));
    setBestOfferDecline(centsToDollarInput(listing?.best_offer_auto_decline_cents));
    // US-2250: quantity defaults to 1 for a brand-new draft.
    setQuantity(
      listing?.quantity != null && listing.quantity > 0
        ? String(listing.quantity)
        : "1",
    );
    // US-2251: business policies; null means "use my account default".
    setShippingPolicyId(listing?.shipping_policy_id ?? null);
    setPaymentPolicyId(listing?.payment_policy_id ?? null);
    setReturnPolicyId(listing?.return_policy_id ?? null);
    const seededPrimary =
      listing?.primary_photo_id &&
      photos.some((p) => p.id === listing.primary_photo_id)
        ? listing.primary_photo_id
        : (photos[0]?.id ?? null);
    setPrimaryPhotoId(seededPrimary);
    setMeasurements(
      (item.measurements as Record<string, number | string> | null) ?? {},
    );
    // items_full exposes SKU as item_number; container/location_bin pass through.
    setStorageSku(item.item_number ?? "");
    setStorageLocation(item.location_bin ?? "");
    setStorageContainer(item.container ?? "");
    // Item bookkeeping (items_full names these purchase_date/purchase_price).
    setItemStatus(item.status);
    setItemCategory(normalizeItemCategory(item.category));
    setCategoryTouched(false);
    setSourcedBy(item.sourced_by ?? "");
    setAcquiredDate(item.purchase_date?.slice(0, 10) ?? "");
    setInitialised(true);
  }, [
    initialised,
    item,
    listing,
    photos,
    photosLoading,
    promoDefaultsLoading,
    promoDefaults,
  ]);

  // US-2256: everything this page owns and could lose, in one string. Compared
  // against the snapshot taken at seed time (and re-stamped after each save) to
  // decide whether leaving costs the seller anything.
  //
  // The eBay aspect map is deliberately NOT in here: the picker reports its
  // aspects up on mount and prefills derivable ones, so folding that into the
  // snapshot would make a freshly-opened composer look dirty before the seller
  // touched it — which is how a guard stops working. Aspect edits are tracked
  // separately against the picker's FIRST report (aspectBaseline below).
  const formSnapshot = useMemo(
    () =>
      JSON.stringify([
        title,
        description,
        ebayCondition,
        conditionDesc,
        price,
        cost,
        quantity,
        scheduledAt,
        primaryPhotoId,
        promoteEnabled,
        promoMode,
        promoRate,
        listingFormat,
        bestOfferEnabled,
        bestOfferAccept,
        bestOfferDecline,
        shippingPolicyId,
        paymentPolicyId,
        returnPolicyId,
        measurements,
        storageSku,
        storageLocation,
        storageContainer,
        itemStatus,
        itemCategory,
        sourcedBy,
        acquiredDate,
      ]),
    [
      title, description, ebayCondition, conditionDesc, price, cost, quantity,
      scheduledAt, primaryPhotoId, promoteEnabled, promoMode, promoRate,
      listingFormat, bestOfferEnabled, bestOfferAccept, bestOfferDecline,
      shippingPolicyId, paymentPolicyId,
      returnPolicyId, measurements, storageSku, storageLocation,
      storageContainer, itemStatus, itemCategory, sourcedBy, acquiredDate,
    ],
  );
  // Stamped once seeding finishes — computing it inside the seed effect would
  // read the pre-setState values and bake in a snapshot that never matches.
  useEffect(() => {
    if (initialised && savedSnapshot === null) setSavedSnapshot(formSnapshot);
  }, [initialised, savedSnapshot, formSnapshot]);
  // The picker reports its aspect map up on mount, AFTER its own prefill — so the
  // first report is the baseline, not a seller edit (US-2256). Lives here rather
  // than in SpecificsSection because the dirty state belongs to the form.
  function handleAspectsChange(next: Record<string, string[]> | null) {
    setLivePickedAspects(next);
    const encoded = JSON.stringify(next ?? null);
    if (aspectBaseline.current === null) {
      aspectBaseline.current = encoded;
    } else if (encoded !== aspectBaseline.current) {
      setAspectsDirty(true);
    }
  }

  // The aspect map as the picker FIRST reported it (post-mount, post-prefill).
  const aspectBaseline = useRef<string | null>(null);
  // US-2381: photo edits persist immediately and PhotoManager pushes the net
  // change to eBay on unmount. This page's resubmit already sends
  // `photos: true`, so it owns the flag and clears it after a successful push —
  // otherwise leaving the page re-sends the same gallery. The ref lived on
  // ItemCanvas until that component was deleted, and nothing took it over.
  const photosDirtyRef = useRef(false);
  const [aspectsDirty, setAspectsDirty] = useState(false);
  const isDirty =
    (savedSnapshot !== null && formSnapshot !== savedSnapshot) || aspectsDirty;
  // Re-stamp both baselines: a save makes the current form the saved form.
  function markSaved() {
    setSavedSnapshot(formSnapshot);
    aspectBaseline.current = JSON.stringify(livePickedAspects ?? null);
    setAspectsDirty(false);
  }
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);
  // US-2256: in-app navigation (the Close button's navigate(-1), a sidebar click)
  // is intercepted for a real confirm; refresh/tab-close falls back to the
  // browser's own prompt. Both live in useNavigationGuard (US-2032).
  const guard = useNavigationGuard(isDirty && !saving);

  // The category publish will actually use: the seller's live pick, else the
  // saved listing override, else the inventory mirror. US-2261: derived ONCE —
  // this cascade used to be re-typed in five places (the ad-rate suggestion, the
  // save path, the spec/description diff, the comps panel), so changing the
  // resolution order meant finding all five.
  const resolvedCategoryId = useMemo(
    () =>
      livePickedCategoryId ??
      listing?.platform_category_id ??
      ebayMapping?.ebay_category_id ??
      null,
    [livePickedCategoryId, listing?.platform_category_id, ebayMapping?.ebay_category_id],
  );
  // US-2381: the chosen category's real aspect spec, so the save-time column
  // projection writes the name THIS category uses ("Colour", "US Shoe Size")
  // rather than the registry's first guess. Same queryKey the picker uses, so
  // React Query serves it from cache — this is not a second fetch.
  const specAspectsQuery = useEbayCategoryAspects(resolvedCategoryId);
  const specAspects = useMemo(
    () => specAspectsQuery.data?.aspects.aspects ?? [],
    [specAspectsQuery.data],
  );
  // The category/aspect values the picker seeds FROM — deliberately the saved
  // pair only (no live pick), so the picker owns its own edit state.
  const savedCategoryId =
    listing?.platform_category_id ?? ebayMapping?.ebay_category_id ?? null;
  const savedAspects =
    listing?.item_specifics_override ?? ebayMapping?.ebay_aspects ?? null;

  // The cost being EDITED, not the saved one, so margin moves as you type.
  // Declared here (not beside the profit panel) because both save paths close
  // over it — reading it from a closure defined above its own declaration was a
  // temporal-dead-zone hazard waiting for someone to call a save earlier.
  const parsedCost = cost.trim() === "" ? null : Number.parseFloat(cost);
  const effectiveCost =
    parsedCost != null && Number.isFinite(parsedCost) && parsedCost >= 0
      ? parsedCost
      : null;

  // eBay condition/category awareness: many apparel leaves (Dresses, Women's
  // Sweaters, …) accept only {New, New other, New with defects, Pre-owned -
  // Excellent/Good/Fair} and REJECT the legacy USED_* tiers — a fixed list would
  // offer conditions eBay bounces at publish. Drive the dropdown off the leaf's
  // allowed conditions; fall back to the full static list when the category is
  // unknown/unrestricted or the (advisory) fetch fails.
  const { data: categoryConditions } = useEbayCategoryConditions(resolvedCategoryId);
  const conditionOptions = useMemo<{ value: string; label: string }[]>(() => {
    const base =
      categoryConditions?.restricted && categoryConditions.options.length > 0
        ? categoryConditions.options.map((o) => ({ value: o.value, label: o.label }))
        : EBAY_CONDITION_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
    // Never silently drop a value already chosen (by the seller or the AI) that
    // isn't in the category's allowed set — keep it selectable with a marker so
    // the seller can see it and pick a valid one instead.
    if (ebayCondition && !base.some((o) => o.value === ebayCondition)) {
      base.push({
        value: ebayCondition,
        label: `${conditionLabel(ebayCondition)} — not accepted by this category`,
      });
    }
    return base;
  }, [categoryConditions, ebayCondition]);
  // The chosen condition is rejected by this leaf's allow-list (drives an inline
  // warning under the dropdown so publish doesn't surprise the seller).
  const conditionRejected = Boolean(
    ebayCondition &&
      categoryConditions?.restricted &&
      categoryConditions.options.length > 0 &&
      !categoryConditions.options.some((o) => o.value === ebayCondition),
  );

  // US-561: fetch the category-suggested ad rate and, only when the seller has
  // no rate yet, seed the box with it — never clobbering an explicit edit.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await edgeFetch(
          `/api/flipdesk/ebay/marketing/ad-rate-suggestion?category_id=${
            encodeURIComponent(resolvedCategoryId ?? "")
          }`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { suggested_rate_pct?: number };
        if (cancelled || typeof data.suggested_rate_pct !== "number") return;
        setPromoSuggested(data.suggested_rate_pct);
        setPromoRate((prev) =>
          prev.trim() === "" ? String(data.suggested_rate_pct) : prev,
        );
      } catch {
        /* non-fatal — the rate box keeps its current value */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolvedCategoryId]);

  // Memoized so the title-chip memo below has a stable dependency — a fresh
  // array identity every render defeated it entirely.
  const keywords = useMemo(() => (item ? titleKeywords(item) : []), [item]);
  const group = item ? templateGroupFor(item) : "generic";
  const primaryPhoto =
    photos.find((p) => p.id === primaryPhotoId) ?? photos[0] ?? null;
  const resolvedDescription = item
    ? interpolateDescription(description, item, measurementUnit)
    : description;

  // US-2255: EVERY filled item specific, not a fixed six. The preview used to
  // render a hardcoded Brand/Style/Size/Category/Condition/Grade table, so a
  // seller who carefully filled fifteen specifics saw four of them and had no way
  // to check their work — the preview quietly disagreed with what would publish.
  //
  // Row order is the aspect map's own key order, which the picker builds from
  // eBay's taxonomy response, so required-and-prominent aspects lead the way they
  // do on eBay. The item-column fallbacks stay for never-edited drafts whose
  // aspect map is still empty.
  const specifics = useMemo(() => {
    if (!item) return [] as { label: string; value: string }[];
    // Prefer the LIVE aspect values (what publish will actually send) over the
    // item columns, so the preview can never disagree with the editable eBay
    // specifics below it while the user types.
    const aspects = livePickedAspects ?? savedAspects ?? {};
    const rows: { label: string; value: string | null }[] = [];
    const seen = new Set<string>();
    for (const [name, values] of Object.entries(aspects)) {
      // eBay joins multi-value aspects with a comma on the view-item page.
      const value = (values ?? [])
        .map((v) => v.trim())
        .filter(Boolean)
        .join(", ");
      if (!value) continue;
      rows.push({ label: name, value });
      seen.add(name.toLowerCase());
    }
    // Column fallbacks — only for a field the aspect map doesn't already carry,
    // so an edited Brand is never shadowed by a stale column.
    const fallback = (label: string, value: string | null | undefined) => {
      if (seen.has(label.toLowerCase())) return;
      rows.push({ label, value: value ?? null });
    };
    fallback("Brand", item.brand);
    fallback("Style", item.style);
    fallback("Size", item.size);
    fallback("Category", item.category);
    fallback("Condition", item.grade_label ?? "Pre-owned");
    if (item.grade_value != null) {
      rows.push({
        label: "GradeThread Grade",
        value: `${item.grade_value.toFixed(1)} / 10`,
      });
    }
    return rows.filter(
      (r): r is { label: string; value: string } =>
        !!r.value && r.value.trim() !== "",
    );
  }, [item, livePickedAspects, savedAspects]);

  // US-551: the AI's original draft, snapshotted at generation. Drives the
  // per-field diff chips + revert-to-AI. Null for manually-created drafts.
  const aiSnapshot = listing?.ai_generated_snapshot ?? null;

  function applyTemplate() {
    if (!item) return;
    setDescription(
      interpolateDescription(DESCRIPTION_TEMPLATES[group], item, measurementUnit),
    );
    toast.info(`Applied the ${group} template.`);
  }

  function appendKeyword(kw: string) {
    const next = title.trim() ? `${title.trim()} ${kw}` : kw;
    setTitle(next.slice(0, TITLE_MAX));
  }

  // US-552: kick off a one-click AI rewrite of the title or description. The
  // result reuses AiFillPanel so the seller reviews, accepts, and the
  // acceptance is logged — nothing is applied silently.
  async function runRewrite(action: RewriteAction) {
    if (!item) return;
    setRewriteAction(action);
    try {
      const res = await aiRewrite.mutateAsync({
        item_id: item.id,
        action,
        title,
        // Hide the appended GradeThread credentials block from the model so it
        // isn't rewritten into prose — it's re-appended verbatim on accept.
        description: splitSellerCredentials(description).body,
      });
      setRewriteResult(res);
      setRewritePanelOpen(true);
    } catch {
      /* error toast handled by the hook */
    } finally {
      setRewriteAction(null);
    }
  }

  // Apply whatever the seller accepted in AiFillPanel back into the form. Edits
  // remain fully overridable — this just seeds the field with the AI's text.
  function applyRewrite(accepted: AcceptedField[]) {
    for (const f of accepted) {
      if (f.field === "title") setTitle(f.value.slice(0, TITLE_MAX));
      else if (f.field === "description") {
        // A rewrite (esp. "regenerate") writes a fresh description that drops the
        // "Graded by GradeThread — Condition Grade X" line AND the appended
        // GradeThread Verified Seller block. Re-insert both idempotently so the
        // draft/preview keeps showing the grade (the server re-asserts it at
        // publish via applyGradeListingPromotion) and the seller-credentials card
        // (carried over from the pre-rewrite description). No-ops when absent.
        const withGrade = item ? ensureGradeLine(f.value, item) : f.value;
        setDescription(ensureSellerCredentials(withGrade, description));
      }
    }
    if (accepted.length > 0) {
      toast.success("AI rewrite applied. Save the draft to keep it.");
    }
  }

  // Persists the draft. Returns the listing row's id on success (so the
  // publish flow can save-then-push in one click), null on failure. By
  // default the user STAYS on the composer — the publish CTA lives here, so
  // navigating away after save (the old behavior) forced a detour through
  // the Drafts list to publish.
  // US-1490: a published listing the seller can revise in place. The composer
  // doubles as the live-listing editor; this gates the "Save & resubmit to eBay"
  // action and banner. platform_offer_id is required for a revise (the server
  // 409s without it), so include it in the live check.
  const isLiveListing =
    !!listing &&
    listing.listing_status === "active" &&
    !!listing.platform_offer_id;

  // One editor, three shapes. The FIELDS are identical at every status — only
  // the header wording and the footer actions differ, which is the whole point:
  // a listing can't lose an editor (and with it a required item specific)
  // because it moved forward in the pipeline.
  //   draft  → Save draft + Publish
  //   live   → Save & resubmit to eBay (a revise, not a re-publish)
  //   closed → Save only (sold / shipped / ended / archived — nothing to push)
  const isClosedItem =
    item != null &&
    (["sold", "shipped", "completed", "returned", "archived"] as const).some(
      (s) => s === item.status,
    );
  const editorMode: "draft" | "live" | "closed" = isLiveListing
    ? "live"
    : isClosedItem
      ? "closed"
      : "draft";

  // US-1077/US-1081: listing provenance drives the sync authority AND the badge.
  // A brand-new draft (no listing row yet) is GradeThread-originated by definition.
  const listingOrigin = listing ? deriveListingOrigin(listing) : "gradethread";
  const isEbayOrigin = listingOrigin === "ebay";
  // US-2258: WHICH fields eBay owns on a mirror is not a judgement call — the
  // edge has one list, EBAY_OWNED_LISTING_FIELDS in
  // services/edge-functions/src/lib/sync-precedence.ts, and an inbound pull
  // overwrites exactly those while origin='ebay'. That list is:
  //
  //   listing_title · listing_price · listing_description · quantity ·
  //   platform_category_id · listing_status · is_active · listed_at ·
  //   platform_listing_id · platform_offer_id · listing_url
  //
  // Of the ones this form edits: title, price, description and QUANTITY are
  // locked below (quantity was editable here and would have been silently
  // reverted by the next sync). platform_category_id is eBay-owned too, but its
  // editor also holds the item specifics — which are NOT on the list and must
  // stay editable — so the picker warns instead of locking.
  //
  // Deliberately NOT locked, because eBay does not own them: ebay_condition,
  // ebay_condition_description, item_specifics_override, the listing format,
  // Promoted Listings, Best Offer, the business policies, measurements, cost,
  // and everything on inventory_items.
  const ebayOwnedHint = isEbayOrigin
    ? "eBay owns this field on a listing it created — change it on eBay."
    : undefined;
  // US-1080: on an eBay-ORIGINATED mirror, eBay owns title/price/description —
  // the server rejects edits to them. This editor is now the only one an
  // eBay-created listing ever opens in, so the lock (and the way out of it) has
  // to live here rather than on the retired canvas.
  // US-1968: converting the listing to a managed Inventory offer is what
  // unlocks revise/reprice/promote. Only offer it for something actually live on
  // eBay — a mirror with no platform_listing_id has nothing to migrate.
  const migrateListings = useMigrateEbayListings();
  const canMigrate = isEbayOrigin && !!listing?.platform_listing_id;
  const ebayItemUrl =
    listing?.listing_url ||
    (listing?.platform_listing_id
      ? `https://www.ebay.com/itm/${listing.platform_listing_id}`
      : null);

  // Pre-push reminder: item specifics and the description are independent, so a
  // specific the seller CHANGED this session can leave the description stale. Flag
  // only changed shared fields (Brand/Size/Color/Material) whose new value the
  // description doesn't mention — pushing then would need a needless revise/relist.
  // Baseline = last-saved specifics; current = the live picker edits (or baseline
  // when untouched). Recomputes live, so editing the description clears it.
  const specDescMismatches = useMemo<
    { field: SharedDescField; value: string }[]
  >(() => {
    const currentAspects = livePickedAspects ?? savedAspects;
    if (!currentAspects) return [];
    const base = sharedValuesFromAspects(savedAspects, resolvedCategoryId);
    const cur = sharedValuesFromAspects(currentAspects, resolvedCategoryId);
    const out: { field: SharedDescField; value: string }[] = [];
    for (const field of SHARED_DESC_FIELDS) {
      const val = cur[field];
      if (!val) continue;
      const changed =
        (base[field] ?? "").trim().toLowerCase() !== val.trim().toLowerCase();
      if (!changed) continue;
      if (!descriptionMentions(description, val)) out.push({ field, value: val });
    }
    return out;
  }, [livePickedAspects, savedAspects, resolvedCategoryId, description]);

  // Resolve the eBay-owned fields from the live picker state, falling back to the
  // saved listing override and the inventory mirror — shared by the draft save
  // and the live "Save & resubmit" so the two paths can't drift (US-557/US-825).
  function resolveListingFields() {
    const parsedPrice = Number.parseFloat(price);
    // First POSITIVE price wins (mirrors the seed logic) — never persist a
    // 0 that would later shadow the item's target price at publish.
    const resolvedPrice =
      [
        Number.isFinite(parsedPrice) ? parsedPrice : null,
        item?.target_price,
        item?.list_price,
      ].find((p): p is number => p != null && p > 0) ?? 0;
    const liveAspects = livePickedAspects ?? savedAspects;
    const baseAspects =
      liveAspects && Object.keys(liveAspects).length > 0 ? liveAspects : null;
    const liveSources =
      livePickedSources ??
      listing?.item_specifics_sources ??
      ebayMapping?.ebay_aspect_sources ??
      null;
    const baseSources = baseAspects ? (liveSources ?? {}) : {};
    // US-2381: the columns own their specifics, so project them forward — but
    // only after the reverse pass, and only through the loaded category spec.
    // `columnWriteBack()` reads the PRE-projection aspects on purpose: it is
    // what turns a manually typed Brand into the column value this projection
    // then re-asserts. Reversing the order would clobber that edit.
    const { aspects: resolvedAspects, sources: resolvedSources } =
      baseAspects && specAspects.length > 0 && itemAspectSource
        ? projectColumnAspectsForSpec(
            { ...itemAspectSource, ...columnWriteBack().columns },
            specAspects,
            baseAspects,
            baseSources,
          )
        : { aspects: baseAspects, sources: baseSources };
    return { resolvedPrice, resolvedCategoryId, resolvedAspects, resolvedSources };
  }

  // The whole listing-side form, in the shape the pure payload builders take.
  // Both save paths read this one object, so a field can't be wired into the
  // draft save and forgotten in the live one (US-2248).
  function composerListingState(): ComposerListingState {
    const { resolvedPrice, resolvedAspects, resolvedSources } =
      resolveListingFields();
    // US-1898: seller overrides win over the comp-derived default, then clamp to
    // eBay's constraints (decline < accept < price). Same math the edge
    // re-applies at publish (best-offer.ts).
    const bestOffer = bestOfferEnabled
      ? resolveBestOfferThresholds({
          priceCents: resolvedPrice > 0 ? Math.round(resolvedPrice * 100) : 0,
          p25Cents: listing?.price_range_low_cents ?? null,
          p75Cents: listing?.price_range_high_cents ?? null,
          acceptOverrideCents: dollarInputToCents(bestOfferAccept),
          declineOverrideCents: dollarInputToCents(bestOfferDecline),
        })
      : { autoAcceptCents: null, autoDeclineCents: null };
    return {
      title,
      description,
      ebayCondition,
      conditionDesc,
      resolvedPrice,
      resolvedCategoryId,
      resolvedAspects,
      resolvedSources,
      scheduledPublishAt: localInputToIso(scheduledAt),
      primaryPhotoId,
      promoteEnabled,
      promoMode,
      promoRate,
      listingFormat,
      bestOfferEnabled,
      bestOfferAcceptCents: bestOffer.autoAcceptCents,
      bestOfferDeclineCents: bestOffer.autoDeclineCents,
      quantity,
      shippingPolicyId,
      paymentPolicyId,
      returnPolicyId,
    };
  }

  // The whole item-side patch, assembled from the same state every save path
  // sees — including the Storage & SKU fields that used to need a second Save
  // button and were silently dropped by "Save draft" (US-2249).
  function composerItemPatch(
    resolvedAspects: Record<string, string[]> | null,
    resolvedSources: Record<string, string | undefined>,
  ): Record<string, unknown> {
    return buildItemPatch(
      {
        resolvedCategoryId,
        resolvedAspects,
        resolvedSources,
        measurements,
        effectiveCost,
        sourcedBy,
        acquiredDate,
        categoryTouched,
        itemCategory,
        storageSku,
        storageLocation,
        storageContainer,
        // Forward-only: never regress a listed/sold item back to "drafted". The
        // seller's Item details pick is the `selected` input — resolveStatus
        // lets a deliberate non-prep choice (archived, sold) win outright and
        // otherwise takes the furthest of current / picked / earned.
        resolvedStatus: resolveStatus(item!.status, itemStatus, {
          ...factsOf(item!),
          hasDraftListing: true,
        }),
      },
      {
        ...aspectWriteBackPatch(),
        ...categoryCascadePatch(),
        ...manualCategoryGarmentPatch(),
      },
    );
  }

  // Category coupling: when the seller fixes the eBay category here, derive the
  // coarse item_category from the chosen breadcrumb and cascade it — plus the
  // garment_type/category grading axis it seeds when the FAMILY changes — onto
  // the item in the SAME save, so one correction propagates to all three
  // category axes. Returns extra inventory_items patch fields, or {} when we
  // can't confidently derive a coarse category or it already matches.
  function categoryCascadePatch(): Record<string, unknown> {
    // A coarse category the seller set by hand in Item details this session is
    // the newer human intent — don't let the eBay-path derivation overwrite it.
    if (categoryTouched) return {};
    const derived = ebayPathToItemCategory(livePickedCategoryPath);
    if (!derived) return {};
    const current = ebayMapping?.item_category ?? null;
    if (derived === current) return {};
    const patch: Record<string, unknown> = { item_category: derived };
    // Only re-derive the garment axis when the coarse FAMILY actually changes,
    // so a same-family correction keeps the seller's garment pick.
    return { ...patch, ...(garmentPatchForCategoryChange(current, derived) ?? {}) };
  }

  // US-2384: the OTHER route into a coarse-category change — the seller picking
  // it by hand in Item details. `categoryCascadePatch` deliberately stands down
  // when `categoryTouched`, so before this existed the manual route wrote
  // `item_category` alone and left the garment axis on the old family: a
  // clothing → shoes correction still graded as clothing, with both garment
  // fields populated so nothing looked wrong. Same helper as the eBay-leaf
  // route, so the two cannot drift apart again.
  function manualCategoryGarmentPatch(): Record<string, unknown> {
    if (!categoryTouched) return {};
    const next = itemCategory === "" ? null : itemCategory;
    return garmentPatchForCategoryChange(ebayMapping?.item_category ?? null, next) ?? {};
  }

  // Reverse-sync shared fields: fold manual/AI edits made in the eBay specifics
  // editor back into the item's structured fields (brand/size/color/material/
  // style columns + US-821 canonical attributes) in the SAME save, so shared
  // values are single-entry. The item page projects the OTHER direction on its
  // save (projectColumnAspects), and the edge re-asserts the columns at
  // publish/revise — without this write-back a Brand typed here would be
  // clobbered by the stale column and the seller would have to enter it twice.
  // Returns extra inventory_items patch fields for the mirror update.
  // US-2381: reads the PRE-projection aspect map deliberately. The forward
  // projection stamps what it writes `inventory_derived`, and the reverse pass
  // only writes back `manual`/`ai_extracted` — so running this on projected
  // aspects would silently drop the seller's own specifics edit.
  function columnWriteBack(): AspectWriteBack {
    const liveAspects = livePickedAspects ?? savedAspects;
    if (!liveAspects || !itemAspectSource) {
      return { columns: {}, attributes: {} };
    }
    const liveSources =
      livePickedSources ??
      listing?.item_specifics_sources ??
      ebayMapping?.ebay_aspect_sources ??
      {};
    return reverseProjectAspectColumns(itemAspectSource, liveAspects, liveSources);
  }

  function aspectWriteBackPatch(): Record<string, unknown> {
    const wb = columnWriteBack();
    const patch: Record<string, unknown> = { ...wb.columns };
    if (Object.keys(wb.attributes).length > 0) {
      patch.attributes = { ...(ebayMapping?.attributes ?? {}), ...wb.attributes };
    }
    return patch;
  }

  async function saveDraft(): Promise<string | null> {
    if (!item) return null;
    if (!title.trim()) {
      toast.error("Title is required.");
      return null;
    }
    setSaving(true);
    try {
      // US-557: ONE coherent save. The category picker reports its live aspect
      // map up via onAspectsChange; here we write it to BOTH the listing
      // override (item_specifics_override — the per-listing canonical copy
      // publish reads first) AND the inventory mirror (ebay_aspects — the
      // fallback) in the same save, so the two stores never diverge and a
      // picker edit can't vanish by skipping a separate save.
      const state = composerListingState();
      const payload = buildDraftListingPayload(state, {
        inventoryItemId: item.id,
        existingStatus: listing?.listing_status ?? null,
        reviewedAt: new Date().toISOString(),
      });

      let listingId: string;
      // Update whenever a listing row EXISTS, whatever its status. The old
      // `&& item.listing_status === "draft"` gate was safe only because this
      // editor was draft-only; reached from Active/Sold it would insert a
      // SECOND listings row for the same item and orphan the live one.
      if (item.listing_id) {
        const { error } = await supabase
          .from("listings")
          .update(payload as never)
          .eq("id", item.listing_id);
        if (error) throw error;
        listingId = item.listing_id;
      } else {
        const { data: created, error } = await supabase
          .from("listings")
          // US-1077: a composer-authored draft is GradeThread-originated.
          .insert({ ...payload, listing_origin: "gradethread" } as never)
          .select("id")
          .single();
        if (error) throw error;
        listingId = (created as { id: string }).id;
      }

      // Mirror the category + aspects onto the item in the same save so the
      // inventory store stays in lockstep with the listing override (US-557),
      // fold specifics edits back into their backing item fields so shared
      // values (Brand & co.) stay single-entry, and carry the Storage & SKU
      // fields that used to be stranded behind their own Save (US-2249).
      const { error: sErr } = await supabase
        .from("inventory_items")
        .update(
          composerItemPatch(
            state.resolvedAspects,
            state.resolvedSources,
          ) as never,
        )
        .eq("id", item.id);
      // US-2249: the SKU rides the main save now, so the main save is where a
      // duplicate-SKU collision has to offer the merge.
      if (sErr) {
        if (await skuMerge.offerSkuMerge(sErr, storageSku)) return null;
        throw sErr;
      }

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["listing", item.listing_id] });
      await qc.invalidateQueries({
        queryKey: ["inventory_item_ebay", item.id],
      });
      // US-1895: refresh the recommended-coverage meter after an aspect save.
      await qc.invalidateQueries({ queryKey: ["recommended-coverage", item.id] });
      markSaved();
      toast.success(item.listing_id ? "Saved." : "Draft saved.");
      return listingId;
    } catch (err) {
      toast.error(`Save failed: ${errorMessage(err)}`);
      return null;
    } finally {
      setSaving(false);
    }
  }

  // US-2249: the Storage & SKU fields ride the main save now, so the duplicate-SKU
  // recovery has to be reachable from every save path rather than living inside a
  // storage-only handler. Returns true when the error WAS a SKU collision and the
  // merge dialog has been opened (the caller stops there — the update rolled back);
  // false means "not mine, keep throwing".
  // ── US-2264: workflow actions ported off the unmounted ItemCanvas ──────────
  // Fields "Complete with AI" targets. Blank ones are what it offers to fill.
  const ENRICHABLE: {
    key: string;
    value: string | null | undefined;
  }[] = item
    ? [
        { key: "brand", value: item.brand },
        { key: "style", value: item.style },
        { key: "size", value: item.size },
        { key: "color", value: ebayMapping?.color },
        { key: "material", value: ebayMapping?.material },
        { key: "item_category", value: item.category },
        { key: "garment_type", value: ebayMapping?.garment_type },
        { key: "garment_category", value: ebayMapping?.garment_category },
      ]
    : [];
  const missingFields = ENRICHABLE.filter((f) => !String(f.value ?? "").trim());
  const hasAiText = [title, description, conditionDesc].some((t) => t.trim());
  const canCompleteWithAi = photos.length > 0 || hasAiText;

  // Read the garment from its own photos and fill what's blank. The server also
  // resolves the eBay category + item specifics and persists them on the item,
  // which is why a successful fill remounts the specifics picker below (its
  // `key`) — otherwise the picker would keep showing the values it seeded with.
  async function handleCompleteWithAi() {
    if (!item) return;
    const photoRefs = photos.map((ph) => ({
      url: supabase.storage
        .from("item-photos")
        .getPublicUrl(ph.storage_path ?? "").data.publicUrl,
      type: ph.photo_type,
    }));
    const text = [title, description, conditionDesc]
      .filter((t) => t.trim())
      .join("\n");
    if (photoRefs.length === 0 && !text.trim()) {
      toast.error("Add photos or a description for the AI to work from.");
      return;
    }
    const known: Record<string, unknown> = {};
    for (const f of ENRICHABLE) {
      if (String(f.value ?? "").trim()) known[f.key] = f.value;
    }
    try {
      const result = await aiExtract.mutateAsync({
        text: text || undefined,
        photos: photoRefs,
        known_fields: known,
        item_id: item.id,
      });
      setAiFillResult(result);
      setAiFillOpen(true);
      // US-2270: the category/aspects pass runs in the BACKGROUND now, so the old
      // `if (result.ebay)` branch never fired — the category was resolved and
      // persisted while this picker kept showing the values it seeded with, and
      // nothing told the seller either way. Refresh now and again once the pass
      // has had time to land.
      const plan = planEbayPrepRefresh(result);
      if (plan.refreshNow) {
        await qc.invalidateQueries({
          queryKey: ["inventory_item_ebay", item.id],
        });
      }
      if (plan.message) {
        if (plan.pending) toast.message(plan.message);
        else toast.success(plan.message);
      }
      if (plan.refreshAfterMs != null) {
        const itemId = item.id;
        window.setTimeout(() => {
          void qc.invalidateQueries({ queryKey: ["inventory_item_ebay", itemId] });
          void qc.invalidateQueries({ queryKey: ["items_full"] });
        }, plan.refreshAfterMs);
      }
    } catch {
      /* error toast handled by the hook */
    }
  }

  // Accepted AI values are written to the ITEM, not to composer state: brand,
  // size, colour and material are owned by the eBay specifics editor (US-557
  // single-entry), and the picker re-seeds from the item on remount.
  async function applyAiFill(accepted: AcceptedField[]) {
    if (!item || accepted.length === 0) return;
    const patch: Record<string, unknown> = {};
    for (const f of accepted) {
      const v = f.value.trim();
      if (!v) continue;
      patch[f.field === "item_category" ? "item_category" : f.field] = v;
    }
    if (Object.keys(patch).length === 0) return;
    const { error } = await supabase
      .from("inventory_items")
      .update(patch as never)
      .eq("id", item.id);
    if (error) {
      toast.error(`Couldn't save the AI's answers: ${errorMessage(error)}`);
      return;
    }
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    await qc.invalidateQueries({ queryKey: ["inventory_item_ebay", item.id] });
    toast.success("Applied to this item.");
  }

  // US-1088: a cut-off or missing size label is common on thrifted stock, and the
  // flat-lay photos already carry the answer.
  async function handleEstimateSize() {
    if (!item) return;
    try {
      const r = await sizeAi.mutateAsync({ item_id: item.id });
      if (!r.size) {
        toast.info(
          "Size AI couldn't read a size — add a measurement or flat-lay photo and retry.",
        );
        return;
      }
      const { error } = await supabase
        .from("inventory_items")
        .update({ size: r.size } as never)
        .eq("id", item.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["inventory_item_ebay", item.id] });
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
    } catch (err) {
      toast.error(`Couldn't save the size: ${errorMessage(err)}`);
    }
  }

  // Duplicate: a second, near-identical piece from the same haul. Copies the
  // catalog fields and nothing transactional — no photos, no listing, no cost
  // history, and it starts at "cataloged" rather than inheriting a status it
  // hasn't earned.
  async function handleDuplicate() {
    if (!item) return;
    try {
      const { data: created, error } = await supabase
        .from("inventory_items")
        .insert({
          user_id: item.user_id,
          title: item.item_title,
          brand: item.brand,
          style: item.style,
          size: item.size,
          item_category: item.category,
          source_id: item.source_id,
          sourced_by: item.sourced_by,
          acquired_price: item.purchase_price,
          acquired_date: item.purchase_date,
          description: item.item_description,
          condition_notes: item.notes,
          measurements: item.measurements,
          status: "cataloged",
        } as never)
        .select("id")
        .single();
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Duplicated — opening the copy.");
      navigate(`/dashboard/flipdesk/items/${(created as { id: string }).id}`);
    } catch (err) {
      toast.error(`Duplicate failed: ${errorMessage(err)}`);
    }
  }

  // Relist: an ended or unsold item goes back to the top of the pipeline with its
  // catalog work intact, so it can be re-priced and pushed again.
  async function handleRelist() {
    if (!item) return;
    try {
      // Deliberately a direct write, not advanceItemStatus: that helper is
      // forward-only by design, and a relist is the one legitimate case for
      // moving an item BACKWARD — an ended or returned piece returns to the
      // pipeline at "comped" with its catalog work intact, to be re-priced.
      const { error } = await supabase
        .from("inventory_items")
        .update({ status: "comped" } as never)
        .eq("id", item.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Ready to relist — review the price and publish again.");
    } catch (err) {
      toast.error(`Relist failed: ${errorMessage(err)}`);
    }
  }

  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // The pinned CTA either takes the seller to the section that is blocking, or
  // performs the step outright when there is nothing to fill in.
  function runNextAction(kind: string) {
    switch (kind) {
      case "measure":
        scrollToSection("composer-measurements");
        break;
      case "photograph":
        scrollToSection("composer-photos");
        break;
      case "grade":
      case "grading":
      case "review_grade":
        scrollToSection("composer-grading");
        break;
      case "comp":
      case "draft":
        scrollToSection("composer-category");
        break;
      case "list":
        setMarkListedOpen(true);
        break;
      case "sell":
        setRecordSaleOpen(true);
        break;
      case "relist":
        void handleRelist();
        break;
      default:
        break;
    }
  }

  function togglePushPlatform(platform: CrossListingPlatform) {
    // US-1114: never select a channel awaiting platform approval — publishing it
    // would 503. The UI disables it too; this guards persisted/programmatic state.
    if (MARKETPLACE_TIER[platform] === "api_pending") return;
    setPushPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  }

  // US-1490: save edits to an ALREADY-published listing IN PLACE — update the
  // existing active row (never insert a new draft) and never flip
  // listing_status/is_active, so it stays live on eBay. Mirrors category/aspects
  // onto the item WITHOUT regressing its 'listed' status. Returns the listing id.
  async function saveLiveListing(): Promise<string | null> {
    if (!item || !item.listing_id) return null;
    if (!title.trim()) {
      toast.error("Title is required.");
      return null;
    }
    setSaving(true);
    try {
      // US-2248: the SAME content columns as a draft save. This path used to be
      // a hand-written subset that had fallen a dozen columns behind — a seller
      // could change the promote rate, Best Offer limits, format, quantity or
      // primary photo on a live listing, get a success toast, and lose all of it.
      const state = composerListingState();
      const { error } = await supabase
        .from("listings")
        .update(buildLiveListingPatch(state) as never)
        .eq("id", item.listing_id);
      if (error) throw error;
      // Mirror onto the item. Status still comes from resolveStatus (forward-
      // only, and a listed item's earned status can't regress) rather than being
      // skipped — the seller can now move a live item to sold/archived from the
      // same Item details card they use on a draft.
      const { error: sErr } = await supabase
        .from("inventory_items")
        .update(
          composerItemPatch(
            state.resolvedAspects,
            state.resolvedSources,
          ) as never,
        )
        .eq("id", item.id);
      if (sErr) {
        if (await skuMerge.offerSkuMerge(sErr, storageSku)) return null;
        throw sErr;
      }
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["listing", item.listing_id] });
      await qc.invalidateQueries({ queryKey: ["inventory_item_ebay", item.id] });
      markSaved();
      return item.listing_id;
    } catch (err) {
      toast.error(`Save failed: ${errorMessage(err)}`);
      return null;
    } finally {
      setSaving(false);
    }
  }

  // US-1490: persist the live edits, then push them to eBay via the revise
  // endpoint. resync_ebay_fields re-asserts category/condition/specifics (which
  // the server reads back from the rows we just saved); photos re-syncs the
  // gallery; title/description/price ride along.
  async function handleResubmitClick() {
    const listingId = await saveLiveListing();
    if (!listingId) return;
    const { resolvedPrice } = resolveListingFields();
    try {
      await reviseListing.mutateAsync({
        listingId,
        patch: {
          title: title.trim(),
          description: description.trim() || undefined,
          listing_price: resolvedPrice > 0 ? resolvedPrice : undefined,
          photos: true,
          resync_ebay_fields: true,
        },
      });
      // The gallery just went up with this revise, so PhotoManager's unmount
      // auto-sync must not push it again when the seller leaves (US-2381).
      photosDirtyRef.current = false;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Changes saved and pushed to eBay.");
    } catch (err) {
      const e = err as Error & { status?: number };
      toast.error(
        `eBay rejected the update: ${e.message}. Your changes are saved — fix the issue and resubmit.`,
        { duration: 12_000 },
      );
    }
  }

  // Publish reads the DATABASE, not the form — so save first, then push. One
  // click instead of save → back out → Drafts list → Publish. eBay-only keeps
  // the preflight dialog; any other selection dispatches through cross-push
  // (US-149), which fans the draft out to one listings row per platform.
  async function handlePublishClick() {
    // US-2257: the button is disabled for these, but a keyboard/programmatic
    // path must not slip past — and saving first would leave a draft eBay is
    // about to bounce.
    const { resolvedPrice } = resolveListingFields();
    if (!(resolvedPrice > 0)) {
      toast.error("Set a price above $0 before publishing.");
      return;
    }
    if (conditionRejected) {
      toast.error(
        "That eBay condition isn't accepted by this category — pick an allowed one before publishing.",
      );
      return;
    }
    const listingId = await saveDraft();
    if (!listingId) return;

    // US-1114: drop any channel awaiting platform approval (tier api_pending)
    // before dispatch — it has no live publish path and would 503.
    const platforms = [...pushPlatforms].filter(
      (p) => MARKETPLACE_TIER[p] !== "api_pending",
    );
    if (platforms.length === 1 && platforms[0] === "ebay") {
      setPublishOpen(true);
      return;
    }

    const prices: Partial<Record<CrossListingPlatform, number>> = {};
    for (const p of platforms) {
      const raw = platformPrices[p];
      const parsed = raw != null ? Number.parseFloat(raw) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) prices[p] = parsed;
    }

    try {
      const res = await crossPush.mutateAsync({ listingId, platforms, prices });
      const stubbed: string[] = [];
      const failed: string[] = [];
      for (const p of platforms) {
        const r = res.results[p];
        if (!r) continue;
        if (r.ok) {
          toast.success(`Published to ${MARKETPLACE_LABELS[p]}.`);
        } else if (r.status === 501) {
          stubbed.push(MARKETPLACE_LABELS[p]);
        } else {
          failed.push(
            `${MARKETPLACE_LABELS[p]}: ${r.blockers?.[0] ?? r.error ?? "failed"}`,
          );
        }
      }
      if (stubbed.length > 0) {
        toast.info(
          `${stubbed.join(", ")} listing${stubbed.length === 1 ? "" : "s"} saved locally — publishing there ships soon.`,
        );
      }
      for (const f of failed) toast.error(f, { duration: 12_000 });
    } catch (err) {
      toast.error(`Cross-listing push failed: ${errorMessage(err)}`);
    }
  }

  // US-623: condition-aware sell-through forecast at the price input. Called
  // before the early returns so the hook order is stable; degrades to null when
  // the item/price isn't ready.
  const forecastPriceCents = (() => {
    const p = Number.parseFloat(price);
    return Number.isFinite(p) && p > 0 ? Math.round(p * 100) : 0;
  })();
  const { forecast: sellThroughForecast } = useSellThroughForecast({
    brand: item?.brand,
    q: item?.item_title,
    grade: item?.grade_value ?? null,
    priceCents: forecastPriceCents,
    enabled: !!item,
  });

  // US-1892: title quality meter — utilization band, brand-first, policy/quality
  // lint, and pack-to-80 suggestions from the listing's mined demand terms +
  // high-value filled aspects. Pure (src/lib/title-quality.ts, lockstep with the
  // edge publish lint).
  // US-2261: memoized, and hoisted above the early returns so it CAN be — it ran
  // unconditionally on every keystroke of every field in a 3000-line form.
  const titleMeter = useMemo(
    () =>
      titleQuality({
        title,
        brand: item?.brand ?? null,
        demandTerms: listing?.demand_terms ?? [],
        aspects: livePickedAspects ?? savedAspects ?? {},
      }),
    [title, item?.brand, listing?.demand_terms, livePickedAspects, savedAspects],
  );
  // Merge the existing titleKeywords() chips with the pack suggestions (demand
  // terms + aspects), dropping any token already in the title and de-duping —
  // extends the chips rather than duplicating them (AC2).
  const titleChips = useMemo<string[]>(() => {
    const present = new Set(
      title
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(Boolean),
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [
      ...keywords,
      ...titleMeter.suggestions.map((s) => s.token),
    ]) {
      const key = t.toLowerCase();
      if (!t.trim() || seen.has(key) || present.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [title, keywords, titleMeter]);

  if (isLoading) {
    return (
      <LoadingRegion label="Loading item" className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </LoadingRegion>
    );
  }

  if (!item) {
    return (
      <div className="space-y-3 py-12 text-center">
        <div className="text-sm text-muted-foreground">Item not found.</div>
        <Button variant="outline" onClick={() => navigate(-1)}>
          Go back
        </Button>
      </div>
    );
  }

  const titleLen = title.length;
  // A chip that would push the title past 80 is disabled, never truncated (AC2).
  const chipFits = (kw: string) =>
    (title.trim() ? title.trim().length + 1 + kw.length : kw.length) <= TITLE_MAX;
  // US-2257: the things eBay is CERTAIN to reject, checked before the round-trip.
  // Deliberately only these two: everything softer (missing recommended aspects,
  // a stale description, a thin title) stays a warning, and publish stays
  // server-validated — this is a courtesy gate, not the authority.
  const publishBlocker: string | null = (() => {
    const { resolvedPrice } = resolveListingFields();
    if (!(resolvedPrice > 0)) {
      return "Set a price above $0 before publishing.";
    }
    if (conditionRejected) {
      return "The eBay condition you picked isn't accepted by this category — pick an allowed one.";
    }
    return null;
  })();

  // US-2250: when a variation matrix exists it owns the total quantity, so the
  // composer states the derived number instead of showing an input that
  // resolveQuantity would override. null = no matrix, use the input.
  const variationQuantity =
    listingFormat.format !== "auction" &&
    (listingFormat.variations?.variants.length ?? 0) > 0
      ? resolveQuantity({ quantity, listingFormat })
      : null;
  // A blank/0/negative box saves as 1; say so rather than silently coercing.
  const quantityInvalid =
    quantity.trim() !== "" &&
    !(Number.parseInt(quantity, 10) > 0);
  const parsedPreviewPrice = Number.parseFloat(price);
  const previewPrice = Number.isFinite(parsedPreviewPrice)
    ? parsedPreviewPrice
    : (item.target_price ?? item.list_price ?? null);
  // US-553: forward profit/margin at the current list price.
  const profitEstimate = estimateListingProfit({
    price: Number.isFinite(parsedPreviewPrice) ? parsedPreviewPrice : 0,
    costBasis: effectiveCost,
    shippingCost: item.shipping_cost,
  });
  // US-558: resolve the assigned (default) shipping + return policy names so the
  // preview can show what buyers will actually see at checkout.
  const policyName = (
    type: "fulfillment" | "return",
    defaultId: string | null,
  ): string | null => {
    const list = ebayPolicies?.policies ?? [];
    const chosen =
      list.find((p) => p.policy_type === type && p.policy_id === defaultId) ??
      list.find((p) => p.policy_type === type && p.is_default) ??
      list.find((p) => p.policy_type === type);
    return chosen?.policy_name ?? null;
  };
  // `defaults` is optional-chained too: a policies response without it (edge
  // degradation / unexpected shape) must not crash the whole composer route.
  // US-2251: this listing's OWN policy pick wins over the account default, so
  // the preview shows what will actually publish rather than the default the
  // seller just overrode.
  const shippingPolicyName = policyName(
    "fulfillment",
    shippingPolicyId ?? ebayPolicies?.defaults?.fulfillment_policy_id ?? null,
  );
  const returnPolicyName = policyName(
    "return",
    returnPolicyId ?? ebayPolicies?.defaults?.return_policy_id ?? null,
  );

  // The Save / publish row. Declared here and RENDERED in the sticky preview
  // column (see below) rather than inline at the bottom of the page, so the
  // button the seller presses most is not thirteen cards away from wherever
  // they are editing. Kept as one instance on purpose: duplicating it for a
  // small-screen copy would put two identically-labelled Save buttons in the
  // accessibility tree.
  const actionRow = (
    // Wraps: the publish label can run long ("Save & schedule for Jul 30, 2026,
    // 3:00 PM CDT"), and the preview column is narrower than the full page this
    // row used to span.
    <div className="flex flex-wrap items-center justify-end gap-2">
      {/* US-2256: navigate(-1) is intercepted by the navigation guard when
          there is unsaved work, so this stays a plain navigation and the
          confirm lives in one place. */}
      <Button variant="outline" onClick={() => navigate(-1)} disabled={saving}>
        {isDirty ? "Close without saving" : "Close"}
      </Button>
      {editorMode === "live" ? (
        <>
          {/* An edit that isn't worth an eBay round-trip (cost, bin, sourcing)
              still needs somewhere to land — otherwise the only Save on a live
              listing is a ~5-8s revise the seller may not want. */}
          <Button
            variant="outline"
            onClick={() => void saveLiveListing()}
            disabled={saving || reviseListing.isPending}
            title="Saves your edits in GradeThread without pushing to eBay."
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save without pushing
          </Button>
          <Button
            onClick={() => void handleResubmitClick()}
            disabled={saving || reviseListing.isPending || !ebayConnection}
            title={
              !ebayConnection
                ? "Connect eBay first on the Marketplaces page."
                : "Saves your edits, then pushes them to the live eBay listing."
            }
          >
            {saving || reviseListing.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="mr-2 h-4 w-4" />
            )}
            Save &amp; resubmit to eBay
          </Button>
        </>
      ) : editorMode === "closed" ? (
        // Sold / shipped / returned / archived: the same form, but there is no
        // live offer to push to and nothing to publish. Save is the only verb.
        <Button onClick={saveDraft} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save
        </Button>
      ) : (
        <>
          <Button variant="outline" onClick={saveDraft} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save draft
          </Button>
          <Button
            onClick={() => void handlePublishClick()}
            // US-2257: also blocked on the two things eBay is CERTAIN to
            // reject, so the seller learns it here rather than from eBay's
            // error message after a round-trip.
            disabled={
              saving ||
              crossPush.isPending ||
              pushPlatforms.size === 0 ||
              (pushPlatforms.has("ebay") && !ebayConnection) ||
              publishBlocker != null
            }
            title={
              pushPlatforms.has("ebay") && !ebayConnection
                ? "Connect eBay first on the Marketplaces page."
                : pushPlatforms.size === 0
                  ? "Pick at least one marketplace in the Push to card."
                  : (publishBlocker ??
                    (scheduledAt
                      ? "Saves the draft; it publishes itself at your drop time."
                      : "Saves the draft, then publishes."))
            }
          >
            {crossPush.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : scheduledAt ? (
              <CalendarClock className="mr-2 h-4 w-4" />
            ) : (
              <Rocket className="mr-2 h-4 w-4" />
            )}
            {/* US-2253: a scheduled drop isn't a publish — say what the click
                actually does, and when it happens. */}
            {scheduledAt
              ? `Save & schedule for ${formatInZone(
                  localInputToIso(scheduledAt) ?? "",
                  dropTimezone,
                )}`
              : pushPlatforms.size === 1 && pushPlatforms.has("ebay")
                ? "Save & publish to eBay"
                : `Save & push to ${pushPlatforms.size} marketplace${
                    pushPlatforms.size === 1 ? "" : "s"
                  }`}
          </Button>
        </>
      )}
    </div>
  );

  return (
    // @container: this editor renders at three very different widths — the full
    // item page (wide), the quick-look sheet (max-w-2xl / 672px), and the item
    // detail dialog. Viewport breakpoints can't tell those apart, so `lg:` was
    // splitting the 672px sheet into two ~320px columns on any desktop screen.
    // Container queries below size the layout to the width actually granted.
    <div className="@container space-y-6">
      {showHeader && (
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(-1)}
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">
              {editorMode === "draft" ? "Listing composer" : "Edit item"}
            </h1>
            <p className="truncate text-sm text-muted-foreground">
              {editorMode === "live"
                ? `Editing the live listing for "${item.item_title}".`
                : editorMode === "closed"
                  ? `Editing "${item.item_title}" — this item is no longer listed.`
                  : `Build, preview, and pick photo variants for "${item.item_title}".`}
            </p>
          </div>
          <Badge variant="outline" className="ml-auto shrink-0 font-normal">
            {ITEM_STATUS_LABELS[item.status]}
          </Badge>
        </div>
      )}

      {/* At-a-glance "this IS listed" confirmation. Keys off a genuinely live
          listing (active status + a real eBay offer id) so it never claims
          "listed" for a draft or a publish that didn't complete — the absence of
          the banner is itself the signal that the item isn't live yet. */}
      {isLiveListing && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 dark:border-emerald-500/40 dark:bg-emerald-500/10">
          <BadgeCheck className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
              Listed &amp; live on eBay
            </p>
            <p className="text-xs text-emerald-800 dark:text-emerald-300/90">
              This item is currently listed and buyers can purchase it now
              {listing?.listed_at
                ? ` — went live ${new Date(listing.listed_at).toLocaleDateString()}`
                : ""}.
            </p>
          </div>
          {ebayItemUrl && (
            <a
              href={ebayItemUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-md border border-emerald-400 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 dark:bg-transparent dark:text-emerald-200 dark:hover:bg-emerald-500/10"
            >
              View on eBay ↗
            </a>
          )}
        </div>
      )}

      {/* US-1077/US-1081: listing provenance tag. Provenance decides sync
          authority — GradeThread-originated listings are edited here and pushed to
          eBay; eBay-originated ones are mirrors whose fields eBay owns (edit there). */}
      <div className="flex flex-wrap items-center gap-2">
        {isEbayOrigin ? (
          <>
            <Badge
              variant="outline"
              className="gap-1 border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
            >
              <Store className="h-3.5 w-3.5" />
              eBay-generated listing
            </Badge>
            <span className="text-xs text-muted-foreground">
              Created on eBay — eBay owns the title, price, and description here,
              so those fields are locked. Your grade, specifics, measurements and
              cost stay editable.{" "}
              {ebayItemUrl && (
                <a
                  href={ebayItemUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline underline-offset-2"
                >
                  Edit on eBay ↗
                </a>
              )}
            </span>
            {canMigrate && (
              <Button
                variant="outline"
                size="sm"
                disabled={migrateListings.isPending}
                onClick={() => migrateListings.mutate([listing!.id])}
              >
                {migrateListings.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Manage in FlipDesk
              </Button>
            )}
          </>
        ) : (
          <>
            <Badge
              variant="outline"
              className="gap-1 border-brand-navy/30 bg-brand-navy/5 text-brand-navy dark:text-foreground"
            >
              <BadgeCheck className="h-3.5 w-3.5" />
              GradeThread-generated listing
            </Badge>
            <span className="text-xs text-muted-foreground">
              GradeThread is the source of truth — edit here, then push to eBay.
            </span>
          </>
        )}
      </div>

      {ebayMapping?.ai_generated_aspects_at && (
        <div className="flex items-center gap-2 rounded-md border border-brand-red/30 bg-brand-red/5 p-3 text-sm">
          <Sparkles className="h-4 w-4 text-brand-red-text" />
          <span>
            This draft was generated by AutoLister. Review the title,
            description, condition, item specifics, and price before publishing —
            AI can make mistakes.
          </span>
        </div>
      )}

      {item.grade_value != null && (
        <div className="flex items-center gap-2 rounded-md border border-brand-navy/30 bg-brand-navy/5 p-3 text-sm">
          <Award className="h-4 w-4 text-brand-navy dark:text-foreground" />
          <span>
            Graded {item.grade_value.toFixed(1)}/10
            {item.grade_label ? ` · ${item.grade_label}` : ""}. The grade and a
            certificate link publish in the description automatically. Add a
            grade card to the photo gallery in the Photos card below.
          </span>
        </div>
      )}

      {/* Two columns once the container itself clears 56rem — so the sheet stays
          single-column and the full page splits, instead of both keying off the
          viewport. */}
      <div className="grid gap-6 @4xl:grid-cols-2">
        {/* ── Editor column ───────────────────────────────────────── */}
        <div className="space-y-6">
          {/* US-2264: what to do next with this item, and the AI gap-fills —
              ported off the unmounted ItemCanvas, where they shipped to nobody. */}
          <WorkflowActionsCard
            item={item}
            action={nextAction(item)}
            onRunNextAction={() => runNextAction(nextAction(item).kind)}
            missingCount={missingFields.length}
            canComplete={canCompleteWithAi}
            completing={aiExtract.isPending}
            onCompleteWithAi={() => void handleCompleteWithAi()}
            sizeMissing={!String(item.size ?? "").trim()}
            sizeEstimating={sizeAi.isPending}
            onEstimateSize={() => void handleEstimateSize()}
            onDuplicate={() => void handleDuplicate()}
            onMarkListed={() => setMarkListedOpen(true)}
            onRelist={() => void handleRelist()}
            showMarkListed={!item.listing_id && item.status !== "listed"}
            showRelist={item.status === "archived" || item.status === "returned"}
            busy={saving}
          />

          <PhotosCard
            item={item}
            liveListingId={isLiveListing ? (listing?.id ?? null) : null}
            primaryPhoto={primaryPhoto}
            setPrimaryPhotoId={setPrimaryPhotoId}
            photosDirtyRef={photosDirtyRef}
          />

          <MeasurementsCard
            item={item}
            measurements={measurements}
            setMeasurements={setMeasurements}
          />

          <TitleCard
            title={title}
            setTitle={setTitle}
            item={item}
            titleLen={titleLen}
            titleMeter={titleMeter}
            titleChips={titleChips}
            chipFits={chipFits}
            appendKeyword={appendKeyword}
            aiSnapshot={aiSnapshot}
            aiRewrite={aiRewrite}
            rewriteAction={rewriteAction}
            runRewrite={(a) => void runRewrite(a)}
            isEbayOrigin={isEbayOrigin}
            ebayOwnedHint={ebayOwnedHint}
          />
          <SpecificsSection
            // US-2264: "Complete with AI" persists a resolved category + aspects
            // server-side. The picker seeds ONCE from its initial props, so
            // without this key it would keep showing the pre-AI values.
            key={ebayMapping?.ai_generated_aspects_at ?? "seed"}
            item={item}
            aspectCoverage={aspectCoverage}
            loading={listingLoading || ebayMappingLoading}
            isEbayOrigin={isEbayOrigin}
            savedCategoryId={savedCategoryId}
            savedAspects={savedAspects}
            savedSources={
              (listing?.item_specifics_sources ??
                ebayMapping?.ebay_aspect_sources ??
                null) as AspectSourceMap | null
            }
            needsReviewAspects={(listing?.aspect_review ?? []).map(
              (a) => a.aspect,
            )}
            initialised={initialised}
            measurements={measurements}
            setMeasurements={setMeasurements}
            measurementUnit={measurementUnit}
            itemAspectSource={itemAspectSource}
            onCategoryChange={(id, path) => {
              setLivePickedCategoryId(id);
              setLivePickedCategoryPath(path ?? null);
            }}
            onAspectsChange={handleAspectsChange}
            onSourcesChange={setLivePickedSources}
            onMissingRequiredChange={setMissingRequired}
          />

          {/* Grade this item — restores the "Submit for grading" action in the
              drafts editor (it lived on the item canvas, which the AutoLister/
              Inventory drafts consolidation routed around). Self-contained: shows
              the existing grade + certificate when graded, submission status when
              in flight, or the tier picker + Submit when eligible. */}
          <div id="composer-grading" className="scroll-mt-4">
          <GradeThisItemCard
            item={item}
            preview={gradingPreview}
            liveFields={{
              title,
              garment_type: ebayMapping?.garment_type ?? "",
              garment_category: ebayMapping?.garment_category ?? "",
            }}
            onPatchGarment={(gt, gc) => {
              // The composer doesn't own garment fields; write them straight to
              // the item and refresh the ebayMapping read so the preview clears.
              void (async () => {
                await supabase
                  .from("inventory_items")
                  .update({ garment_type: gt, garment_category: gc } as never)
                  .eq("id", item.id);
                await qc.invalidateQueries({
                  queryKey: ["inventory_item_ebay", item.id],
                });
                await qc.invalidateQueries({ queryKey: ["items_full"] });
              })();
            }}
          />
          </div>

          {/* US-2259: both of these were mounted ONLY on ItemCanvas, which no
              route renders any more — this editor replaced it. Two working
              features (adopt an eBay Catalog product to auto-fill authoritative
              specifics; check the chosen category against the Taxonomy API's
              current suggestion) were unreachable. They belong right under the
              category + specifics editor they act on. */}
          <EbayCatalogMatchCard itemId={item.id} />
          {item.listing_id && <CategoryCheckCard listingId={item.listing_id} />}

          {/* Live comps + price recommendation */}
          <EbayCompsPanel
            itemId={item.id}
            categoryId={resolvedCategoryId}
            brand={item.brand ?? null}
            size={item.size ?? null}
            q={item.item_title ?? ""}
            styleCode={compStyleCode}
            grade={item.grade_value ?? null}
            onTargetPriceUpdated={(value) => {
              // US-1449: flow an applied comp/recommended price straight into the
              // price input so the seller doesn't retype it — and so it wins at
              // save over the stale seeded value (resolveListingFields reads this
              // `price` state first). Clear the estimated/comp-source markers: the
              // seller has now explicitly adopted this price.
              setPrice(String(value));
              setPriceEstimated(false);
              setPriceCompSource(null);
            }}
          />

          <PriceCard
            ebayCondition={ebayCondition}
            setEbayCondition={setEbayCondition}
            conditionOptions={conditionOptions}
            conditionRejected={conditionRejected}
            categoryConditions={categoryConditions}
            conditionDesc={conditionDesc}
            setConditionDesc={setConditionDesc}
            price={price}
            setPrice={setPrice}
            priceEstimated={priceEstimated}
            setPriceEstimated={setPriceEstimated}
            priceCompSource={priceCompSource}
            setPriceCompSource={setPriceCompSource}
            quantity={quantity}
            setQuantity={setQuantity}
            quantityInvalid={quantityInvalid}
            variationQuantity={variationQuantity}
            listingFormat={listingFormat}
            bestOfferEnabled={bestOfferEnabled}
            setBestOfferEnabled={setBestOfferEnabled}
            bestOfferAccept={bestOfferAccept}
            setBestOfferAccept={setBestOfferAccept}
            bestOfferDecline={bestOfferDecline}
            setBestOfferDecline={setBestOfferDecline}
            listing={listing}
            aiSnapshot={aiSnapshot}
            isEbayOrigin={isEbayOrigin}
            ebayOwnedHint={ebayOwnedHint}
          />

          <CostMarginCard
            item={item}
            cost={cost}
            setCost={setCost}
            effectiveCost={effectiveCost}
            parsedPreviewPrice={parsedPreviewPrice}
            profitEstimate={profitEstimate}
            sellThroughForecast={sellThroughForecast}
          />

          {/* Listing format + variations (US-568) */}
          <Card>
            <CardHeader>
              <CardTitle>Format &amp; variations</CardTitle>
              <CardDescription>
                List as a fixed-price Buy It Now or a timed auction, or offer one
                listing in multiple sizes/colors.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ListingFormatControls
                value={listingFormat}
                onChange={setListingFormat}
              />
            </CardContent>
          </Card>

          {ebayConnection && (
            <PoliciesCard
              ebayPolicies={ebayPolicies}
              shippingPolicyId={shippingPolicyId}
              setShippingPolicyId={setShippingPolicyId}
              paymentPolicyId={paymentPolicyId}
              setPaymentPolicyId={setPaymentPolicyId}
              returnPolicyId={returnPolicyId}
              setReturnPolicyId={setReturnPolicyId}
            />
          )}

          <PromoteCard
            promoteEnabled={promoteEnabled}
            setPromoteEnabled={setPromoteEnabled}
            promoMode={promoMode}
            setPromoMode={setPromoMode}
            promoRate={promoRate}
            setPromoRate={setPromoRate}
            promoSuggested={promoSuggested}
            listing={listing}
          />

          <DescriptionCard
            description={description}
            setDescription={setDescription}
            group={group}
            applyTemplate={applyTemplate}
            photoCount={photos.length}
            aiRewrite={aiRewrite}
            rewriteAction={rewriteAction}
            runRewrite={(a) => void runRewrite(a)}
            aiSnapshot={aiSnapshot}
            isEbayOrigin={isEbayOrigin}
            ebayOwnedHint={ebayOwnedHint}
          />

          <ItemDetailsCard
            currentStatus={item.status}
            status={itemStatus}
            onStatusChange={setItemStatus}
            category={itemCategory}
            onCategoryChange={(next) => {
              setItemCategory(next);
              setCategoryTouched(true);
            }}
            sourcedBy={sourcedBy}
            onSourcedByChange={setSourcedBy}
            acquiredDate={acquiredDate}
            onAcquiredDateChange={setAcquiredDate}
            onRecordSale={() => setRecordSaleOpen(true)}
          />

          <StorageSkuCard
            sku={storageSku}
            onSkuChange={setStorageSku}
            location={storageLocation}
            onLocationChange={setStorageLocation}
            container={storageContainer}
            onContainerChange={setStorageContainer}
          />

          {/* ── Publish configuration ────────────────────────────────
              US-2252/US-2253 put these directly above the CTA, because the
              things that decide HOW a listing goes live belong next to the
              button that does it. The CTA has since moved into the sticky rail
              so it's reachable without scrolling, and these stayed EDITABLE —
              so they belong with the rest of the form, last, as the final
              decision before the button: which channels, and when. The button
              still can't outrun them: it names the channels in its own label
              and disables itself with a reason when none are picked. */}
          <PushToCard
            pushPlatforms={pushPlatforms}
            togglePushPlatform={togglePushPlatform}
            platformPrices={platformPrices}
            setPlatformPrices={setPlatformPrices}
            price={price}
          />

          <ListingKit
            itemId={item.id}
            baseName={item.item_number ?? item.item_title ?? item.id}
          />

          {editorMode === "draft" && (
            <ScheduleCard
              scheduledAt={scheduledAt}
              setScheduledAt={setScheduledAt}
              dropTimezone={dropTimezone}
              setDropTimezone={setDropTimezone}
            />
          )}
        </div>

        {/* ── Preview column ──────────────────────────────────────── */}
        {/* Sticks only when it's actually beside the editor (same @4xl threshold
            as the two-column split) — a stuck preview in one-column flow would
            just cover the fields below it. */}
        <div className="space-y-4 @4xl:sticky @4xl:top-4 @4xl:self-start">
          {/* The actions sit ABOVE the preview, first thing in the sticky column,
              so Save is reachable from anywhere in a thirteen-card form. They used
              to live at the very bottom of the page: every save meant scrolling
              past the whole editor to reach the button, which is a tax on the
              action sellers take most often. Ordered actions-then-preview because
              the sticky container clips at the viewport bottom — whatever is last
              is what gets cut off, and that must never be the button. */}
          {actionRow}

          {/* The reasons a save or publish is blocked belong WITH the button, not
              a page-length away from it. Below the row so the button never moves
              as notices appear and clear. */}
          {/* US-825: pre-publish required-aspect check — warn inline (using the same
              required-aspect rule the server blocks on) instead of failing at publish.
              Non-blocking: publish stays server-validated. */}
          {missingRequired.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-2 text-right">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-destructive">
                  {missingRequired.length} required{" "}
                  {missingRequired.length === 1 ? "specific" : "specifics"} missing
                </span>{" "}
                ({missingRequired.slice(0, 4).join(", ")}
                {missingRequired.length > 4 ? "…" : ""}) — eBay will reject publish
                until these are filled in.
              </p>
              {/* US-2257: "above" was doing a lot of work from the bottom of a very
                  long page. Take the seller there instead. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const el = document.getElementById("composer-category");
                  el?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                Go to item specifics
              </Button>
            </div>
          )}

          {/* US-1490: a published listing edits in place — re-pushing to eBay rather
              than re-publishing. Swap the draft/publish actions for "Save &
              resubmit", and explain that edits go live on eBay. */}
          {isLiveListing && (
            <div className="flex items-start justify-end gap-2 text-right">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  This listing is live on eBay.
                </span>{" "}
                Saving will push your edits — including category, condition, and item
                specifics — to the active listing.
              </p>
            </div>
          )}

          {/* Pre-push reminder: item specifics and the description are edited on
              separate tracks, so a specific changed this session can leave the
              description stale. Non-blocking — publish/revise stays enabled; this
              just heads off a needless eBay revise/relist. Clears live as the seller
              updates the description. */}
          {specDescMismatches.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">
                  Item specifics changed — the description may be out of date.
                </p>
                <p className="mt-0.5 text-amber-800 dark:text-amber-300/90">
                  You changed{" "}
                  {specDescMismatches
                    .map((m) => `${SHARED_FIELD_LABELS[m.field]} (${m.value})`)
                    .join(", ")}
                  , but the description doesn&apos;t mention{" "}
                  {specDescMismatches.length === 1 ? "it" : "them"}. Update the
                  description before pushing to eBay to avoid a needless revise.
                </p>
              </div>
            </div>
          )}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Listing preview
                <Badge variant="secondary" className="font-normal">
                  eBay
                </Badge>
              </CardTitle>
              <CardDescription>
                How the drafted listing will render to buyers.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EbayViewItemPreview
                title={title}
                price={previewPrice}
                // US-1571: keep the preview honest — internal + measurement
                // photos never publish (edge filterListablePhotos), so they
                // don't render in the buyer-facing preview either.
                photos={photos.filter((p) => !isNonListablePhotoType(p.photo_type))}
                primaryPhotoId={primaryPhoto?.id ?? null}
                conditionLabel={
                  ebayCondition
                    ? conditionLabel(ebayCondition)
                    : (item.grade_label ?? "Pre-owned")
                }
                specifics={specifics}
                description={resolvedDescription}
                shippingCost={item.shipping_cost}
                shippingPolicyName={shippingPolicyName}
                returnPolicyName={returnPolicyName}
                showBadge={false}
                gradeValue={item.grade_value}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <PublishToEbayDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        itemId={item.id}
      />

      {/* US-552: review/accept the AI rewrite — reuses the extract panel so
          accept-all, confidence tiers, and acceptance logging all carry over. */}
      <AiFillPanel
        open={rewritePanelOpen}
        onOpenChange={setRewritePanelOpen}
        result={rewriteResult}
        currentValues={{ title, description }}
        fieldLabels={{ title: "Title", description: "Description" }}
        onApply={applyRewrite}
      />

      {/* US-2256: thirteen cards of edits used to vanish on one stray click —
          Close had no confirm, and neither did a sidebar click or a refresh. */}
      <AlertDialog
        open={guard.blocked}
        onOpenChange={(open) => {
          if (!open) guard.cancelLeave();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              You have changes to this listing that haven&apos;t been saved. If
              you leave now they&apos;ll be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={guard.cancelLeave}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction onClick={guard.confirmLeave}>
              Leave and discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* US-2264: the manual "it's live somewhere else" bridge. */}
      <MarkListedDialog
        item={markListedOpen ? item : null}
        onClose={() => setMarkListedOpen(false)}
      />

      {/* US-2264: review/accept what the AI read off the photos. Reuses the
          extract panel, so accept-all, confidence tiers and acceptance logging
          all carry over. */}
      <AiFillPanel
        open={aiFillOpen}
        onOpenChange={setAiFillOpen}
        result={aiFillResult}
        currentValues={Object.fromEntries(
          ENRICHABLE.map((f) => [f.key, String(f.value ?? "")]),
        )}
        onApply={(accepted) => void applyAiFill(accepted)}
      />

      {/* US-2260: the real sold path — captures price, fees and date, then
          advances the status via advanceItemStatus. */}
      <RecordSaleDialog
        item={recordSaleOpen ? item : null}
        onClose={() => setRecordSaleOpen(false)}
      />

      {skuMerge.mergeState && (
        <MergeSkuDialog
          open
          sku={skuMerge.mergeState.sku}
          current={skuMerge.mergeState.current}
          existing={skuMerge.mergeState.existing}
          merging={skuMerge.merging}
          onCancel={skuMerge.cancelMerge}
          onConfirm={(overrides) =>
            void skuMerge.confirmMerge(overrides, {
              // The rolled-back save never committed these.
              location_bin: storageLocation.trim() || null,
              container: storageContainer.trim() || null,
            })
          }
        />
      )}
    </div>
  );
}
