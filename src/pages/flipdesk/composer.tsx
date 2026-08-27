import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  ArrowLeft,
  Save,
  Loader2,
  Award,
  Rocket,
  Sparkles,
  Store,
  BadgeCheck,
  CalendarClock,
  PackageX,
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
import { useSellerListingDefaults } from "@/hooks/use-seller-listing-defaults";
import {
  resolveSeedAuctionDuration,
  resolveSeedBestOffer,
  resolveSeedFormat,
  resolveSeedQuantity,
} from "@/lib/listing-defaults";
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
import { ebayCategoryLeaf, garmentDescriptorFor } from "@/lib/measurement-templates";
import { applyMeasurementsBlock } from "@/lib/measurements";
import { titleQuality } from "@/lib/title-quality";
import {
  AUTOSAVE_DELAY_MS,
  parseAutosavePrice,
  shouldAutosavePrice,
  shouldAutosaveTitle,
  type FieldSaveState,
} from "@/lib/composer-autosave";
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
import { buildComposerAiInput } from "@/lib/composer-ai-input";
import { COMPOSER_FOCUS_ANCHORS } from "@/lib/publish-blockers";
import { useDescriptionBlocks } from "@/hooks/use-description-blocks";
import {
  applyWholeText,
  DEFAULT_DESCRIPTION_BLOCKS,
  type BlockRowContext,
} from "@/lib/description-blocks";
import type { DescriptionBlock } from "@/types/database";
import {
  inferDepartment,
  mapEbayCondition,
  projectColumnAspectsForSpec,
  reverseProjectAspectColumns,
  type AspectWriteBack,
  type ItemAspectSource,
} from "@/lib/ebay-prefill";
import {
  INITIAL_ASPECT_DIRTY_STATE,
  reduceAspectReport,
  stampAspectsSaved,
  type AspectDirtyState,
} from "@/lib/composer-dirty";
import { deriveListingOrigin, type EbayStateMarker } from "@/lib/listing-origin";
import { ebayPathToItemCategory } from "@/lib/ebay-category-map";
import { previewGradingReadiness } from "@/lib/grading-readiness";
import { garmentPatchForCategoryChange } from "@/lib/garment-mapping";
import { planEbayPrepRefresh } from "@/lib/ai-ebay-prep";
import type { AspectSourceMap } from "@/lib/aspect-provenance";
import { EbayCatalogMatchCard } from "@/components/flipdesk/ebay-catalog-match-card";
import { CategoryCheckCard } from "@/components/flipdesk/category-check-card";
import { GradeThisItemCard } from "@/components/flipdesk/grade-this-item-card";
import { SavedTemplatePicker } from "@/components/flipdesk/saved-template-picker";
import {
  AiFillPanel,
  type AcceptedField,
} from "@/components/flipdesk/ai-fill-panel";
import {
  useAiRewrite,
  useListingCopy,
  type AiExtractResponse,
  type RewriteAction,
} from "@/hooks/use-ai-extract";
import { listingCopyToFill } from "@/lib/listing-copy-fill";
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
  useListingQuality,
  useEbayCategoryAspects,
  useEbayCategoryConditions,
  useEbayConnection,
  useEbayPolicies,
  useEbayReviseListing,
  useMigrateEbayListings,
  useRecommendedCoverage,
} from "@/hooks/use-ebay";
import { useCrossPush } from "@/hooks/use-cross-listing";
import {
  useEndListing,
  useUpdateListingPrice,
} from "@/hooks/use-listing-lifecycle";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useSellThroughForecast } from "@/hooks/use-forecast";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import type {
  ItemCategory,
  ItemPhotoRow,
  ItemStatus,
  ListingRow,
} from "@/types/database";
import { changesFromItemDiff } from "@/lib/title-sync";
import { buildTitleSyncPatch, type TitleSyncPatch } from "@/lib/title-sync-patch";
import { MergeSkuDialog } from "@/components/flipdesk/merge-sku-dialog";
import { RecordSaleDialog } from "@/components/flipdesk/record-sale-dialog";
import { ItemDetailsCard } from "@/components/flipdesk/composer/item-details-card";
import { StorageSkuCard } from "@/components/flipdesk/composer/storage-sku-card";
import { PhotosCard } from "@/components/flipdesk/composer/photos-card";
import { MeasurementsCard } from "@/components/flipdesk/composer/measurements-card";
import { TitleCard } from "@/components/flipdesk/composer/title-card";
import type { TitleChip } from "@/components/flipdesk/composer/title-card";
import { useTitleConflicts } from "@/hooks/use-title-conflicts";
import { QualityCard } from "@/components/flipdesk/composer/quality-card";
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
import { HelpLink } from "@/components/help/help-link";


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
  const confirm = useConfirm();
  const endListing = useEndListing();
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
  // US-2626: a measurement the seller just corrected has to reach the LISTING,
  // not only the item. Every measurement edit — dragging an anchor point on the
  // MeasureCard photo, resizing a line, typing a value into the form, or the
  // automatic pass filling blanks — routes through here so the description's
  // measurements block is rewritten from the current numbers.
  //
  // applyMeasurementsBlock is marker-delimited and idempotent: it strips any
  // existing block before appending, so repeated saves never stack duplicates,
  // and clearing every measurement removes the section instead of leaving a
  // stale one behind. The seller's own prose above the markers is untouched.
  const applyMeasurements = useCallback(
    (next: Record<string, number | string>) => {
      setMeasurements(next);
      setDescription((prev) =>
        applyMeasurementsBlock(prev, next, measurementUnit)
      );
    },
    [measurementUnit],
  );

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
  // US-1898/US-2405: Best Offer toggle + auto-accept/auto-decline (dollar
  // strings, typed by the seller; blank saves NULL = no threshold at all).
  // Persisted to best_offer_*.
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
  // US-2634: Title and Price autosave. The `*SavedRef`s hold what the DATABASE
  // has — seeded from the row, re-stamped by every write (autosave and both
  // explicit saves). The `pending*Ref`s hold a debounced edit that has not
  // landed yet, so leaving the page can flush it instead of dropping it. See
  // src/lib/composer-autosave.ts for the rules and the reason they exist.
  const titleSavedRef = useRef<string | null>(null);
  const pendingTitleRef = useRef<string | null>(null);
  const priceSavedRef = useRef<number | null>(null);
  const pendingPriceRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const [titleSaveState, setTitleSaveState] = useState<FieldSaveState>("idle");
  const [priceSaveState, setPriceSaveState] = useState<FieldSaveState>("idle");
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
  // US-2673: the breadcrumb of whatever category is in effect — the fresh pick
  // OR the one resolved from a saved draft's id. Feeds the measurement template
  // only; `livePickedCategoryPath` above is what a SAVE acts on, and conflating
  // the two would cascade the coarse category on load.
  const [resolvedCategoryPath, setResolvedCategoryPath] = useState<
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
  // US-2442: TWO producers now feed that one panel and one apply handler: the
  // rewrite, which reworks text the seller already has, and listing-copy, which
  // writes the title and description from scratch. Hence the neutral naming:
  // the state below is "the AI copy awaiting review", whichever route made it.
  const [rewriteAction, setRewriteAction] = useState<RewriteAction | null>(null);
  const [aiCopyResult, setAiCopyResult] = useState<AiExtractResponse | null>(
    null,
  );
  const [aiCopyPanelOpen, setAiCopyPanelOpen] = useState(false);
  const aiRewrite = useAiRewrite();
  const listingCopy = useListingCopy();
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
  // US-2852: the seller's listing defaults (format, Best Offer, quantity). Same
  // gate as the promo defaults — seeding before they land would write the
  // platform default into the snapshot and read as a pending change.
  const { data: listingDefaults, isLoading: listingDefaultsLoading } =
    useSellerListingDefaults();

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

  // US-2918: the department the size check resolves a brand's chart by. Prefer
  // an eBay Department specific the seller has already set — that is a stated
  // fact — and fall back to inferDepartment reading the title, style and size
  // text. Null is a fine answer: the endpoint drops to a generic chart rather
  // than guessing a department, and says so in the note.
  const itemDepartment = useMemo<string | null>(() => {
    const stated = (ebayMapping?.attributes ?? {})["Department"];
    if (typeof stated === "string" && stated.trim()) return stated.trim();
    return itemAspectSource ? inferDepartment(itemAspectSource) : null;
  }, [ebayMapping, itemAspectSource]);

  // Seed editable fields once the item, photos, and listing have settled.
  // Everything the item already knows is carried in (description, condition
  // notes, grade-derived condition, target price) so the composer never asks
  // the user to re-enter data — they review and adjust instead.
  useEffect(() => {
    if (initialised || !item) return;
    if (item.listing_id && !listing) return; // wait for the listing fetch
    if (promoDefaultsLoading) return; // wait for the seller promote default
    if (listingDefaultsLoading) return; // wait for the seller listing defaults
    // Wait for photos too — seeding primary_photo_id against an empty (still-
    // loading) set would seed null and Save would WIPE the saved primary photo.
    if (photosLoading) return;
    const seededTitle = (listing?.listing_title ?? item.item_title ?? "").slice(
      0,
      TITLE_MAX,
    );
    setTitle(seededTitle);
    // US-2634: the baseline the autosave compares against is what the row
    // already holds. Stamping it here (not "" ) is what stops the very first
    // render from writing the seed straight back.
    titleSavedRef.current = seededTitle.trim();
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
    // US-2634: same baseline rule as the title — the value the box was SEEDED
    // with, so the first render can't write the seed straight back. Note it is
    // the seeded value rather than `listing.listing_price`: when the price came
    // from the item's target price, the seller has not decided anything yet, and
    // materializing it into the listing row would silently clear the "AI
    // estimate — verify" badge on a price nobody reviewed.
    priceSavedRef.current = parseAutosavePrice(
      seedPrice != null ? String(seedPrice) : "",
    );
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
    // US-2852: a draft with no listings row follows the seller's defaults; a
    // saved row always wins, including its falsey values (see listing-defaults.ts).
    const centsToStr = (c: number | null | undefined) =>
      typeof c === "number" && c > 0 ? String(c / 100) : "";
    const seedFormat = resolveSeedFormat(listing, listingDefaults);
    setListingFormat({
      format: seedFormat,
      auctionStartPrice: centsToStr(listing?.auction_start_price_cents),
      auctionReservePrice: centsToStr(listing?.auction_reserve_price_cents),
      auctionBuyItNowPrice: centsToStr(listing?.auction_buy_it_now_price_cents),
      auctionDuration: resolveSeedAuctionDuration(listing, listingDefaults),
      variations: listing?.variations ?? null,
    });
    // US-1898/US-2405: Best Offer thresholds are never re-derived from comps.
    // US-2852 adds ONE seed source and only for a draft that has no listing row:
    // the seller's own percent-of-price defaults, converted once against the
    // price seeded above and then owned by the cents columns like any other.
    const seedBestOffer = resolveSeedBestOffer(
      listing,
      listingDefaults,
      seedFormat,
      seedPrice != null ? Math.round(seedPrice * 100) : 0,
    );
    setBestOfferEnabled(seedBestOffer.enabled);
    setBestOfferAccept(centsToDollarInput(seedBestOffer.acceptCents));
    setBestOfferDecline(centsToDollarInput(seedBestOffer.declineCents));
    // US-2250: quantity defaults to 1 for a brand-new draft, or the seller's own
    // default when they set one (fixed price only — an auction is always 1).
    setQuantity(String(resolveSeedQuantity(listing, listingDefaults, seedFormat)));
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
    listingDefaultsLoading,
    listingDefaults,
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
  // Keyed rather than positional so `markSaved` can stamp a field the SAVE
  // itself changed (the cascaded item_category) without re-listing all 27.
  const snapshotValues = useMemo(
    () => ({
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
    }),
    [
      title, description, ebayCondition, conditionDesc, price, cost, quantity,
      scheduledAt, primaryPhotoId, promoteEnabled, promoMode, promoRate,
      listingFormat, bestOfferEnabled, bestOfferAccept, bestOfferDecline,
      shippingPolicyId, paymentPolicyId,
      returnPolicyId, measurements, storageSku, storageLocation,
      storageContainer, itemStatus, itemCategory, sourcedBy, acquiredDate,
    ],
  );
  const formSnapshot = useMemo(
    () => JSON.stringify(snapshotValues),
    [snapshotValues],
  );
  // Stamped once seeding finishes — computing it inside the seed effect would
  // read the pre-setState values and bake in a snapshot that never matches.
  useEffect(() => {
    if (initialised && savedSnapshot === null) setSavedSnapshot(formSnapshot);
  }, [initialised, savedSnapshot, formSnapshot]);
  // Aspect edits are dirty only once the SELLER has made one — the rule and the
  // reason it is not "the first report wins" live in src/lib/composer-dirty.ts.
  function handleAspectsChange(next: Record<string, string[]> | null) {
    setLivePickedAspects(next);
    const encoded = JSON.stringify(next ?? null);
    const prev = aspectDirtyRef.current;
    const nextState = reduceAspectReport(
      prev,
      encoded,
      sellerEditedAspects.current,
    );
    aspectDirtyRef.current = nextState;
    if (nextState.dirty !== prev.dirty) setAspectsDirty(nextState.dirty);
  }

  // Baseline + dirty flag together, so the reducer owns both transitions. The
  // React state below mirrors `dirty` purely to trigger a re-render.
  const aspectDirtyRef = useRef<AspectDirtyState>(INITIAL_ASPECT_DIRTY_STATE);
  // Latched by the picker's first genuine seller edit; never unlatched. After a
  // save `markSaved` re-stamps the baseline, so a latched-but-saved form is
  // clean without needing to forget that the seller was here.
  const sellerEditedAspects = useRef(false);
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
  //
  // `overrides` are fields the save itself changed on the way out — today just
  // the cascaded item_category. They have to be folded in HERE rather than left
  // to their own setState, because this runs in the same tick: stamping the
  // pre-cascade snapshot and then setting the new category would leave the form
  // reading as dirty the instant it finished saving.
  function markSaved(overrides?: Partial<typeof snapshotValues>) {
    setSavedSnapshot(
      overrides
        ? JSON.stringify({ ...snapshotValues, ...overrides })
        : formSnapshot,
    );
    aspectDirtyRef.current = stampAspectsSaved(
      JSON.stringify(livePickedAspects ?? null),
    );
    setAspectsDirty(false);
    // US-2634: an explicit save wrote the title and price too, so the autosave
    // baselines move with it. Without this the next keystroke would re-write a
    // value the database already has.
    const savedTitle = (
      typeof overrides?.title === "string" ? overrides.title : title
    ).trim();
    if (savedTitle) {
      titleSavedRef.current = savedTitle;
      pendingTitleRef.current = null;
      setTitleSaveState("idle");
    }
    const savedPrice = parseAutosavePrice(
      typeof overrides?.price === "string" ? overrides.price : price,
    );
    if (savedPrice !== null) {
      priceSavedRef.current = savedPrice;
      pendingPriceRef.current = null;
      setPriceSaveState("idle");
    }
  }

  // US-2634: stamp ONE field into the saved snapshot. `markSaved` would stamp
  // all 27, which after a title autosave would declare the seller's
  // untouched-but-unsaved description clean and switch off the leave-warning
  // that protects it.
  function markFieldSnapshot(field: "title" | "price", next: string) {
    setSavedSnapshot((prev) => {
      if (prev === null) return prev;
      try {
        const parsed = JSON.parse(prev) as typeof snapshotValues;
        return JSON.stringify({ ...parsed, [field]: next });
      } catch {
        return prev;
      }
    });
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
  // US-2595: the measurement template has to key off the GARMENT ("blazer",
  // "shorts"), not the vertical. `items_full.category` collapses to "clothing"
  // the moment item_category is set, and that resolves to the generic
  // length+width template — which is why a blazer was never asked for a chest
  // or a sleeve. The garment columns aren't in the view, but `ebayMapping`
  // already fetches them on the side for the specifics editor.
  // US-2673: the eBay leaf leads. Switching the category from Women's Pants to
  // Men's Sweaters is clothing -> clothing, so the coarse cascade sees no change
  // and never touches garment_type — the measurement card kept asking for a
  // waist. The leaf is the one field that actually moved.
  const measurementGarment = useMemo(
    () =>
      garmentDescriptorFor({
        ebay_leaf: ebayCategoryLeaf(resolvedCategoryPath),
        garment_category: ebayMapping?.garment_category,
        garment_type: ebayMapping?.garment_type,
        category: item?.category,
        title: item?.item_title,
      }) || null,
    [
      resolvedCategoryPath,
      ebayMapping?.garment_category,
      ebayMapping?.garment_type,
      item?.category,
      item?.item_title,
    ],
  );
  const group = item ? templateGroupFor(item, measurementGarment) : "generic";
  const primaryPhoto =
    photos.find((p) => p.id === primaryPhotoId) ?? photos[0] ?? null;

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

  // US-2960: the description as an ordered list of named blocks. The renderer
  // is edge-only, so this holds the ARRAY and asks
  // /api/flipdesk/description/* for every string it shows — including the
  // legacy conversion, which comes back rendered so the preview matches the
  // stored description byte for byte before the seller changes anything.
  const descriptionBlocks = useDescriptionBlocks({
    listingId: item?.listing_id ?? null,
    unit: measurementUnit,
    seed: DEFAULT_DESCRIPTION_BLOCKS as DescriptionBlock[],
  });

  // What each row says about itself. Derived rows name the field they read
  // rather than previewing it — the preview panel is where the bytes live.
  const blockRowContext: BlockRowContext = useMemo(
    () => ({
      attributes: {
        brand: item?.brand,
        size: item?.size,
        color: ebayMapping?.color,
        material: ebayMapping?.material,
        style: item?.style,
      },
      measurementCount: Object.values(measurements).filter(
        (v) => String(v ?? "").trim() !== "",
      ).length,
      unit: measurementUnit,
      gradeValue: item?.grade_value ?? null,
      // US-2961 adds the account-level snippets and their names; until then a
      // snippet row falls back to its own override text.
      snippetNames: {},
    }),
    [
      item?.brand,
      item?.size,
      item?.style,
      item?.grade_value,
      ebayMapping?.color,
      ebayMapping?.material,
      measurements,
      measurementUnit,
    ],
  );

  /**
   * Fold a whole-description string into the blocks.
   *
   * The garment template, the saved-template picker and the AI rewrite each hand
   * back ONE string for the whole prose part. Blocks are the source of truth, so
   * a string that only reached `description` would be rendered away by the next
   * save. `description` is still set, because the eBay preview card and the AI
   * input read it between saves.
   */
  function applyDescriptionText(next: string) {
    setDescription(next);
    descriptionBlocks.setBlocks(
      applyWholeText(descriptionBlocks.blocks, next),
    );
  }

  // US-2960: the block preview IS the string eBay receives, so it wins whenever
  // the edge renderer has produced one — otherwise the buyer preview above would
  // show one description while the block list below showed another.
  // `description` stays the fallback for a listing with no row yet, where there
  // is no context to render against.
  const resolvedDescription = descriptionBlocks.preview
    ? descriptionBlocks.preview
    : item
      ? interpolateDescription(description, item, measurementUnit)
      : description;

  function applyTemplate() {
    if (!item) return;
    applyDescriptionText(
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
  async function runRewrite(action: RewriteAction, conflictingTitles?: string[]) {
    if (!item) return;
    // US-2442: the two AI copy producers share one review panel, so running
    // both at once would let the slower answer replace the one the seller is
    // already reading, and they would have paid an action for each.
    if (listingCopy.isPending) return;
    setRewriteAction(action);
    try {
      const res = await aiRewrite.mutateAsync({
        item_id: item.id,
        action,
        // US-2677: the titles the seller was just shown, so the rewrite moves
        // away from the same listings the warning named.
        conflicting_titles: conflictingTitles,
        title,
        // Hide the appended GradeThread credentials block from the model so it
        // isn't rewritten into prose — it's re-appended verbatim on accept.
        description: splitSellerCredentials(description).body,
      });
      setAiCopyResult(res);
      setAiCopyPanelOpen(true);
    } catch {
      /* error toast handled by the hook */
    } finally {
      setRewriteAction(null);
    }
  }

  // US-2442: the cold start. Every rewrite action needs text to work on, and
  // the three title ones are refused outright on an empty title, so an item
  // that arrives here with a blank title (saved from capture, or carrying only
  // the US-1569 placeholder) had no AI path at all, which is precisely the case
  // a seller most wants help with. This route reads the item's columns and its
  // photos and writes BOTH fields from scratch.
  //
  // It answers in its own shape, so listingCopyToFill translates it into the
  // /extract shape the panel reads. Filling the fields directly would have been
  // fewer lines and the only AI text on this page that skipped review.
  async function runListingCopy() {
    if (!item) return;
    if (aiRewrite.isPending || listingCopy.isPending) return;
    try {
      const res = await listingCopy.mutateAsync({ item_id: item.id });
      setAiCopyResult(listingCopyToFill(res));
      setAiCopyPanelOpen(true);
    } catch {
      /* error toast handled by the hook (aiErrorToast) */
    }
  }

  // Apply whatever the seller accepted in AiFillPanel back into the form. Edits
  // remain fully overridable — this just seeds the field with the AI's text.
  function applyAiCopy(accepted: AcceptedField[], appliedMessage: string) {
    for (const f of accepted) {
      if (f.field === "title") setTitle(f.value.slice(0, TITLE_MAX));
      else if (f.field === "description") {
        // A fresh description (from "regenerate", or from listing-copy, which
        // never sees the old one at all) drops the
        // "Graded by GradeThread — Condition Grade X" line AND the appended
        // GradeThread Verified Seller block. Re-insert both idempotently so the
        // draft/preview keeps showing the grade (the server re-asserts it at
        // publish via applyGradeListingPromotion) and the seller-credentials card
        // (carried over from the pre-rewrite description). No-ops when absent.
        const withGrade = item ? ensureGradeLine(f.value, item) : f.value;
        // US-2960: the string goes to BOTH — `description` for the eBay preview
        // between saves, and the intro block, which is what actually publishes.
        // applyWholeText strips the credential and grade markers back out, so
        // the blocks that own those sections still print them exactly once.
        applyDescriptionText(ensureSellerCredentials(withGrade, description));
      }
    }
    if (accepted.length > 0) {
      toast.success(appliedMessage);
    }
  }

  // Persists the draft. Returns the listing row's id on success (so the
  // publish flow can save-then-push in one click), null on failure. By
  // default the user STAYS on the composer — the publish CTA lives here, so
  // navigating away after save (the old behavior) forced a detour through
  // the Drafts list to publish.
  // US-1490: a published listing the seller can revise in place. The composer
  // doubles as the live-listing editor; this gates the "Save & resubmit to eBay"
  // action and banner.
  //
  // US-2395 AC5: a MULTI-VARIATION listing counts as live too. eBay publishes
  // those through an inventory_item_group and never mints a platform_offer_id
  // for them, so requiring one classified every live variation listing as a
  // DRAFT — and the footer then offered to "Publish to eBay" something that was
  // already live. That is the worse half of the bug: the revise 409 at least
  // refused, while this invited a seller to publish a duplicate.
  //
  // platform_listing_id is what proves a group listing is live (it is the eBay
  // item id the publish-by-group call returned), which is why the variation
  // branch keys on it rather than on the offer id it will never have.
  const isLiveListing =
    !!listing &&
    listing.listing_status === "active" &&
    (!!listing.platform_offer_id ||
      (!!listing.variations && !!listing.platform_listing_id));

  // US-2684: live on eBay, and nobody can buy it.
  //
  // eBay decrements availableQuantity the moment an order is placed and never
  // restores it when that order is CANCELLED. Under out-of-stock control the
  // listing then just sits there at zero: still up, still holding its item id,
  // its watchers and its search standing, and permanently unbuyable. isLiveListing
  // is true for it — which is how a seller came to be reading a green "buyers can
  // purchase it now" banner over a listing eBay was showing as out of stock,
  // pressing Save & resubmit, and watching nothing change.
  //
  // The MARKER is the signal, not listings.quantity. On a GradeThread-originated
  // listing eBay's number is recorded as drift rather than written to the column
  // (EBAY_OWNED_LISTING_FIELDS applies only while origin='ebay'), so the local
  // quantity keeps reading 1 the entire time the listing is dead. The column is
  // checked as well, because an eBay-origin mirror does have it right.
  const ebayStateMarker = (listing?.platform_fields ?? null) as {
    ebay_state?: EbayStateMarker;
  } | null;
  const ebayOutOfStock =
    isLiveListing &&
    (ebayStateMarker?.ebay_state?.reason === "out_of_stock" ||
      listing?.quantity === 0);

  // US-2657: a row that REACHED the marketplace, whatever its local status says.
  //
  // This is deliberately wider than isLiveListing, and only the End action uses
  // it. A listing row sitting in 'draft' status while carrying an eBay id is
  // still something the delete guard counts as live, so an item in that state
  // could be neither deleted ("this item has a live listing") nor ended (End
  // renders only for isLiveListing here, and only on the Active tab of the
  // Listings page). The seller was left with a duplicate they could not remove
  // and no control anywhere that addressed the row causing it.
  //
  // Safe to offer, because End itself is honest now: the server verifies with
  // eBay before it reconciles, and refuses to mark anything ended while eBay
  // still reports the listing live (US-2641). Mirrors the server's
  // wasPublishedUpstream.
  const wasPublishedListing =
    !!listing &&
    listing.listing_status !== "ended" &&
    listing.listing_status !== "sold" &&
    (!!listing.platform_offer_id ||
      !!listing.platform_listing_id ||
      !!listing.synced_to_ebay_at);
  //
  // Scoped to the End ACTION only. It must not widen anything that pushes TO the
  // marketplace — `liveListingId` feeds PhotoManager's gallery re-sync, and
  // handing it a stale published-draft row would sync photos to a listing that
  // is not live. photo-manager-seams.test.ts pins that separation.
  const canEndListing = isLiveListing || wasPublishedListing;

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

  // ── US-2634: the Title and Price save themselves ───────────────────────────
  //
  // Everything downstream reads the DATABASE, not this form: the Listings tab,
  // the eBay push, and the Google Sheets sync (Inventory tab = the item's own
  // `title`; List Price = `listings.listing_price`). Before this, only the Save
  // button moved either one into those columns, so a seller who fixed a title
  // or a price and navigated away left the ORIGINAL in the row — and the sheet
  // kept syncing it. That read as a sync bug; it was a save that never happened.
  //
  // The title moves BOTH its columns together, exactly as the explicit saves do
  // (US-2593): the listing's `listing_title` and the item's `title`. Writing one
  // alone is how the two drift.
  //
  // Held in refs so the debounce effects below can stay keyed on their own
  // field. Re-pointing them every render is deliberate — the effects read
  // `.current` at fire time, so a write always closes over fresh state without
  // the timer restarting whenever an unrelated field changes.
  const persistTitleRef = useRef<(raw: string) => Promise<void>>(async () => {});
  persistTitleRef.current = async (raw: string) => {
    const next = raw.trim();
    if (!item || !next || next === titleSavedRef.current) {
      pendingTitleRef.current = null;
      return;
    }
    if (mountedRef.current) setTitleSaveState("saving");
    try {
      // Item first, then the listing — the same order (and the same reason) as
      // saveDraft: there is no transaction around the pair, so the half that
      // can fail on its own goes first.
      const { error: itemErr } = await supabase
        .from("inventory_items")
        .update({ title: next } as never)
        .eq("id", item.id);
      if (itemErr) throw itemErr;
      const listingId = listing?.id ?? item.listing_id ?? null;
      if (listingId) {
        const { error: listingErr } = await supabase
          .from("listings")
          .update({ listing_title: next } as never)
          .eq("id", listingId);
        if (listingErr) throw listingErr;
      }
      titleSavedRef.current = next;
      pendingTitleRef.current = null;
      // Stamp the RAW value the seller typed, not the trimmed one written: the
      // snapshot compares against form state, so stamping the trim would leave
      // a trailing space reading as unsaved work forever.
      markFieldSnapshot("title", raw);
      if (mountedRef.current) setTitleSaveState("saved");
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      if (listingId) {
        await qc.invalidateQueries({ queryKey: ["listing", listingId] });
      }
    } catch (err) {
      // Never a toast: this fires while the seller is typing, and a toast per
      // failed keystroke is its own outage. The card shows the state, and the
      // Save button is still there as the deliberate retry.
      console.error("[composer] title autosave failed", err);
      if (mountedRef.current) setTitleSaveState("error");
    }
  };

  // The price has no item-side twin to keep in step: `buildItemPatch` writes no
  // price at all, so the listing row owns it. When there is no listing row yet,
  // the edit goes to the item's `target_price` instead — the next thing the seed
  // order reads, and the sheet's Target Price column — rather than being
  // dropped on the floor until the seller finds the Save button.
  //
  // US-2641: on a LIVE listing the price does NOT go straight into the row. It
  // goes through /listings/:id/price, which pushes to the marketplace FIRST and
  // writes our copy only if that succeeded. Writing the row directly is what let
  // a seller retype a wrong price on a live eBay listing, watch the card say
  // "Price saved", and leave eBay charging the old one — with every FlipDesk
  // surface agreeing with the seller and only eBay disagreeing. A price that is
  // saved locally and not live is the one state this field must never report as
  // saved.
  const updateListingPrice = useUpdateListingPrice();
  // Mirrors the server's wasPublishedUpstream: reaching the marketplace is what
  // makes the price a two-sided fact, and a published-then-drafted row still has
  // a live listing to correct.
  const priceIsLive = !!(
    listing &&
    (listing.platform_offer_id ||
      listing.platform_listing_id ||
      listing.synced_to_ebay_at)
  );
  const persistPriceRef = useRef<(raw: string) => Promise<void>>(async () => {});
  persistPriceRef.current = async (raw: string) => {
    const next = parseAutosavePrice(raw);
    if (!item || next === null || next === priceSavedRef.current) {
      pendingPriceRef.current = null;
      return;
    }
    if (mountedRef.current) setPriceSaveState("saving");
    try {
      const listingId = listing?.id ?? item.listing_id ?? null;
      if (listingId && priceIsLive) {
        await updateListingPrice.mutateAsync({ listingId, price: next });
        // The endpoint owns listing_price; this only clears the AI-estimate flag,
        // which is not part of the lifecycle contract. Typing a price IS the
        // human review that stops it being an unverified estimate.
        await supabase
          .from("listings")
          .update({ price_is_estimated: false } as never)
          .eq("id", listingId);
      } else if (listingId) {
        const { error } = await supabase
          .from("listings")
          // price_is_estimated tracks the explicit save: typing a price IS the
          // human review that stops it being an unverified AI estimate.
          .update({ listing_price: next, price_is_estimated: false } as never)
          .eq("id", listingId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("inventory_items")
          .update({ target_price: next } as never)
          .eq("id", item.id);
        if (error) throw error;
      }
      priceSavedRef.current = next;
      pendingPriceRef.current = null;
      markFieldSnapshot("price", raw);
      if (mountedRef.current) setPriceSaveState("saved");
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      if (listingId) {
        await qc.invalidateQueries({ queryKey: ["listing", listingId] });
      }
    } catch (err) {
      console.error("[composer] price autosave failed", err);
      if (mountedRef.current) setPriceSaveState("error");
    }
  };

  useEffect(() => {
    if (
      !shouldAutosaveTitle({
        initialised,
        isEbayOrigin,
        saving,
        title,
        lastSavedTitle: titleSavedRef.current,
      })
    ) {
      // Typing back to the saved value (or clearing the box) cancels the
      // pending write. Leaving it armed would let the unmount flush resurrect a
      // title the seller had already undone.
      pendingTitleRef.current = null;
      return;
    }
    pendingTitleRef.current = title;
    setTitleSaveState("idle");
    const timer = window.setTimeout(() => {
      void persistTitleRef.current(title);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [title, initialised, isEbayOrigin, saving]);

  useEffect(() => {
    if (
      !shouldAutosavePrice({
        initialised,
        isEbayOrigin,
        saving,
        price,
        lastSavedPrice: priceSavedRef.current,
      })
    ) {
      pendingPriceRef.current = null;
      return;
    }
    pendingPriceRef.current = price;
    setPriceSaveState("idle");
    const timer = window.setTimeout(() => {
      void persistPriceRef.current(price);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [price, initialised, isEbayOrigin, saving]);

  // Leaving mid-debounce must not drop the edit — closing the composer is the
  // exact moment the old behaviour lost work. The writes are fire-and-forget:
  // the component is going away, so nothing is left to render their result.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pendingTitle = pendingTitleRef.current;
      if (pendingTitle) void persistTitleRef.current(pendingTitle);
      const pendingPrice = pendingPriceRef.current;
      if (pendingPrice) void persistPriceRef.current(pendingPrice);
    };
  }, []);

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
    // US-1898 / US-2405: ONLY what the seller typed, clamped to eBay's
    // constraints (decline < accept < price). A blank box saves NULL — it must
    // never be back-filled from the comp band, because the saved number stops
    // tracking the price the moment either one moves. Same math the edge
    // re-applies at publish (best-offer.ts).
    const bestOffer = bestOfferEnabled
      ? resolveBestOfferThresholds({
          priceCents: resolvedPrice > 0 ? Math.round(resolvedPrice * 100) : 0,
          acceptCents: dollarInputToCents(bestOfferAccept),
          declineCents: dollarInputToCents(bestOfferDecline),
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
  // US-2593: the item's own `title` follows the listing title on every save.
  // It never did, so `inventory_items.title` kept whatever the item was named
  // the day it was created while the listing (and eBay, and the Listings tab of
  // the synced sheet) moved on. The Inventory tab of Google Sheets reads THIS
  // column, so a seller who renamed "Size Medium" to "Size 36" saw the old
  // words in their sheet forever. `titlePatch` is the substitution the write-
  // back may have just made (US-1995) — the effective title, not the stale
  // form state. Never written empty: the column is NOT NULL, and both save
  // paths already refuse a blank title before they get here.
  function itemTitlePatch(titlePatch: TitleSyncPatch): Record<string, unknown> {
    const next = (
      typeof titlePatch.listing_title === "string" ? titlePatch.listing_title : title
    ).trim();
    return next ? { title: next } : {};
  }

  function composerItemPatch(
    resolvedAspects: Record<string, string[]> | null,
    resolvedSources: Record<string, string | undefined>,
    titlePatch: TitleSyncPatch,
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
        ...itemTitlePatch(titlePatch),
      },
    );
  }

  // US-1995: the specifics editor writes Brand/Size/Color/Style back onto the
  // item columns (aspectWriteBackPatch above), so the listing TITLE has to
  // follow — otherwise correcting a brand here leaves the OLD brand in the one
  // field buyers search hardest.
  //
  // THIS IS A REGRESSION, NOT A NEW FEATURE. US-1891 shipped the substitution on
  // the item canvas; the composer replaced that canvas and never inherited it,
  // so the flagship item surface has been writing stale titles since. The story
  // that filed this (US-1995) predates the canvas deletion and names surfaces
  // that no longer exist — this one is the live gap.
  //
  // Same orchestration every other surface uses: eBay-origin listings are
  // refused outright, both A/B variants move, and a hand-edited or live title is
  // flagged for review rather than silently rewritten.
  function titleSyncPatchFor(isLive: boolean): TitleSyncPatch {
    if (!itemAspectSource) return {};
    const wb = columnWriteBack();
    const cols = wb.columns as Record<string, string | null | undefined>;
    const beforeAttrs = (itemAspectSource.attributes ?? {}) as Record<string, unknown>;
    const beforeDept = beforeAttrs.Department;
    const afterDept = wb.attributes?.Department;
    const before = {
      brand: itemAspectSource.brand ?? null,
      size: itemAspectSource.size ?? null,
      color: itemAspectSource.color ?? null,
      style: itemAspectSource.style ?? null,
      department: typeof beforeDept === "string" ? beforeDept : null,
    };
    // The write-back only reports the columns it CHANGES, so an absent key means
    // "unchanged" and must fall back to the before value — reading it as null
    // would manufacture a change out of every field the seller did not touch.
    return buildTitleSyncPatch({
      baseTitle: title,
      variants: listing?.title_variants,
      changes: changesFromItemDiff(before, {
        brand: cols.brand ?? before.brand,
        size: cols.size ?? before.size,
        color: cols.color ?? before.color,
        style: cols.style ?? before.style,
        department: typeof afterDept === "string" ? afterDept : before.department,
      }),
      snapshotTitle: aiSnapshot?.title ?? null,
      isLive,
      listingOrigin: listing?.listing_origin ?? null,
    });
  }

  // The composer's title is a VISIBLE, editable field, so a substitution the
  // seller cannot see would be undone by their next save: `title` state would
  // still hold the old text and write straight over it. Pushing the synced value
  // back into state and into the saved snapshot is what stops the second save
  // reverting the first.
  function adoptSyncedTitle(patch: TitleSyncPatch): Partial<typeof snapshotValues> | undefined {
    if (typeof patch.listing_title !== "string" || patch.listing_title === title) {
      return undefined;
    }
    setTitle(patch.listing_title);
    return { title: patch.listing_title };
  }

  // The cascade below writes `item_category` as part of the item patch, but the
  // Item details card renders `itemCategory` state, which is seeded ONCE and
  // never re-seeded (re-seeding on every refetch would throw away unsaved
  // edits). So correcting the eBay category used to save the new coarse category
  // and leave the card showing the old one until the seller reloaded the page.
  //
  // Returns the snapshot override rather than relying on its own setState:
  // `markSaved` runs in the same tick and would otherwise stamp the pre-cascade
  // values, leaving the form dirty the moment it finished saving.
  function syncCascadedCategory(
    patch: Record<string, unknown>,
  ): Partial<typeof snapshotValues> | undefined {
    if (!("item_category" in patch)) return undefined;
    const next = normalizeItemCategory(
      typeof patch.item_category === "string" ? patch.item_category : null,
    );
    if (next === itemCategory) return undefined; // manual route: already showing it
    setItemCategory(next);
    return { itemCategory: next };
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
    // `savedAspects` is the baseline that lets an emptied specific read as a
    // deliberate clear rather than as a category that never had the field — the
    // difference between "Material can finally be blanked" and "re-categorising
    // wipes your columns".
    return reverseProjectAspectColumns(
      itemAspectSource,
      liveAspects,
      liveSources,
      savedAspects,
      specAspects,
    );
  }

  function aspectWriteBackPatch(): Record<string, unknown> {
    const wb = columnWriteBack();
    const patch: Record<string, unknown> = { ...wb.columns };
    if (Object.keys(wb.attributes).length > 0) {
      // A null attribute is a clear: DELETE the key rather than storing null,
      // so the jsonb stays a map of real values and every fill-if-blank reader
      // (deriveAspectsFromItem here and on the edge) treats it as absent.
      const next: Record<string, string | string[]> = {
        ...(ebayMapping?.attributes ?? {}),
      };
      for (const [key, value] of Object.entries(wb.attributes)) {
        if (value == null) delete next[key];
        else next[key] = value;
      }
      patch.attributes = next;
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

      // ITEM FIRST, then the listing. These are two statements with no
      // transaction around them, so one of them can fail alone — and the order
      // decides which halves get left behind. The item write carries the
      // specifics write-back (a Brand the seller typed here becomes the item's
      // Brand field); the listing write stores the same aspects stamped
      // `inventory_derived`, i.e. "this came from the column". Listing-first
      // meant a failed item write (a duplicate-SKU 409) published that claim
      // about a column that had never been written, and since derived values are
      // never written back, the seller's Brand was stranded in a specific whose
      // backing field stayed empty. This way a failed item write aborts before
      // the claim is made: the saved map keeps its `manual` provenance and the
      // next successful save still rescues it into the column.
      // Mirror the category + aspects onto the item so the inventory store stays
      // in lockstep with the listing override (US-557), fold specifics edits back
      // into their backing item fields so shared values (Brand & co.) stay
      // single-entry, and carry the Storage & SKU fields that used to be stranded
      // behind their own Save (US-2249).
      // US-1995: fold the title substitution into the SAME listing write. A
      // second statement would be a second failure point on a path that already
      // has no transaction around it, and the half that failed would be the one
      // the seller cannot see.
      // US-2593: computed BEFORE the item write, because the item patch carries
      // the title now and it has to be the post-substitution one. Nothing here
      // reads the database — it is derived from form state — so hoisting it
      // above the write changes no behaviour.
      const titlePatch = titleSyncPatchFor(false);

      const itemPatch = composerItemPatch(
        state.resolvedAspects,
        state.resolvedSources,
        titlePatch,
      );
      const { error: sErr } = await supabase
        .from("inventory_items")
        .update(itemPatch as never)
        .eq("id", item.id);
      // US-2249: the SKU rides the main save now, so the main save is where a
      // duplicate-SKU collision has to offer the merge.
      //
      // US-2445: hand the merge this save ITSELF as the retry. The update above
      // rolled back and the listing write below never ran, so everything the
      // seller edited — the listing title included — is only in the form. The
      // merge frees the SKU and then calls this function again, which is the one
      // recovery that cannot fall behind the columns it has to restore.
      if (sErr) {
        if (
          await skuMerge.offerSkuMerge(sErr, storageSku, {
            pendingItemPatch: itemPatch,
            retrySave: saveDraft,
          })
        )
          return null;
        throw sErr;
      }

      let listingId: string;
      // Update whenever a listing row EXISTS, whatever its status. The old
      // `&& item.listing_status === "draft"` gate was safe only because this
      // editor was draft-only; reached from Active/Sold it would insert a
      // SECOND listings row for the same item and orphan the live one.
      // US-2445: `item` can be a render behind on the post-merge retry. The SKU
      // merge re-points the absorbed record's listings onto THIS item, so an
      // item that had no listing when the save first ran may own one by the time
      // it runs again. Trusting the closed-over null here would take the insert
      // branch and create a SECOND listings row — the exact orphaning the
      // comment above describes, reached by a path that did not exist when it
      // was written. Resolve it from the table instead.
      let targetListingId = item.listing_id;
      if (!targetListingId) {
        const { data: adopted } = await supabase
          .from("listings")
          .select("id")
          .eq("inventory_item_id", item.id)
          .eq("platform", "ebay")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        targetListingId = (adopted as { id: string } | null)?.id ?? null;
      }

      if (targetListingId) {
        const { error } = await supabase
          .from("listings")
          .update({ ...payload, ...titlePatch } as never)
          .eq("id", targetListingId);
        if (error) throw error;
        listingId = targetListingId;
      } else {
        const { data: created, error } = await supabase
          .from("listings")
          // US-1077: a composer-authored draft is GradeThread-originated.
          .insert({ ...payload, ...titlePatch, listing_origin: "gradethread" } as never)
          .select("id")
          .single();
        if (error) throw error;
        listingId = (created as { id: string }).id;
      }

      // US-2960: the description goes LAST, after the item and the listing have
      // both landed. Every derived block reads those rows, so a save that
      // rendered first would print the brand, the size and the measurements the
      // seller just replaced. The route re-renders and writes
      // description_blocks + listing_description in one update, which is why
      // `payload` above still carries the string: it is what the row holds if
      // this call fails, and it is overwritten byte for byte when it succeeds.
      const rendered = await descriptionBlocks.save(listingId);
      if (rendered !== null) setDescription(rendered);

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      // The row we actually wrote, which on a post-merge retry is not
      // necessarily the one this render knew about.
      await qc.invalidateQueries({ queryKey: ["listing", listingId] });
      await qc.invalidateQueries({
        queryKey: ["inventory_item_ebay", item.id],
      });
      // US-1895: refresh the recommended-coverage meter after an aspect save.
      await qc.invalidateQueries({ queryKey: ["recommended-coverage", item.id] });
      markSaved({
        ...syncCascadedCategory(itemPatch),
        ...adoptSyncedTitle(titlePatch),
      });
      toast.success(targetListingId ? "Saved." : "Draft saved.");
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
  async function handleCompleteWithAi(mode: "gap_fill" | "reidentify" = "gap_fill") {
    if (!item) return;
    const photoRefs = photos.map((ph) => ({
      url: supabase.storage
        .from("item-photos")
        .getPublicUrl(ph.storage_path ?? "").data.publicUrl,
      type: ph.photo_type,
    }));
    // US-2817: gap-fill sends the filled fields as known (so only blanks come
    // back); re-identify sends none of them and withholds the item's own
    // generated copy, so the model reads the garment instead of confirming what
    // an older model said about it. See lib/composer-ai-input.ts.
    const { text, known } = buildComposerAiInput(
      {
        title,
        description,
        conditionNotes: conditionDesc,
        fields: ENRICHABLE,
        photoCount: photoRefs.length,
      },
      mode,
    );
    if (photoRefs.length === 0 && !text.trim()) {
      toast.error("Add photos or a description for the AI to work from.");
      return;
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
    // US-2817: record WHERE each value came from, which this path never did.
    // The server stamps provenance for canonical attributes, but brand, style,
    // size, colour and material are applied here, after review — so every value
    // this screen ever wrote looked seller-typed to anything reading
    // ai_field_sources later. That is why a re-identify pass over old stock
    // needs an explicit opt-in: the record it would consult was never written.
    const sources: Record<string, unknown> = {
      ...(item.ai_field_sources ?? {}),
    };
    for (const f of accepted) {
      const v = f.value.trim();
      if (!v) continue;
      patch[f.field === "item_category" ? "item_category" : f.field] = v;
      sources[f.field] = {
        source: f.source,
        confidence: f.confidence,
        accepted: true,
      };
    }
    if (Object.keys(patch).length === 0) return;
    patch.ai_field_sources = sources;
    patch.ai_enriched_at = new Date().toISOString();
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

  // US-2918: the one-click fix behind the size-versus-measurements note. Same
  // write and the same invalidations as Size AI above, because it is the same
  // column — the difference is only who worked out the answer.
  async function handleSizeChange(nextSize: string) {
    if (!item) return;
    const previous = item.size ?? "";
    try {
      const { error } = await supabase
        .from("inventory_items")
        .update({ size: nextSize } as never)
        .eq("id", item.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["inventory_item_ebay", item.id] });
      toast.success(
        previous ? `Size changed from ${previous} to ${nextSize}.` : `Size set to ${nextSize}.`,
      );
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

  // End the live eBay listing from the editor the seller is already in.
  //
  // This action existed only in the Inventory row menu, which made "end it,
  // fix it, relist it" a three-screen detour from the one page that shows what
  // needs fixing. That matters most for the change eBay refuses to make in
  // place — a wrong leaf category — where ending IS the fix, and the seller
  // discovers it here, in the specifics editor, after the push is rejected.
  //
  // Ending drops the item back to a draft, so the footer's own button becomes
  // "Save & publish to eBay" and the relist needs no separate control.
  async function handleEndListing() {
    if (!listing) return;
    const name = listing.listing_title || title.trim() || "This item";
    const ok = await confirm({
      title: isLiveListing ? "End this listing on eBay?" : "Unlink this eBay listing?",
      // US-2657: the wider End covers a row that reached eBay but is not live
      // here any more, and promising the live-listing outcome for that case
      // would be wrong in both directions — there may be nothing to withdraw,
      // and the item is already out of the live pipeline. Say what each one does.
      description: isLiveListing
        ? `"${name}" will be withdrawn from eBay and moved back to Drafts, where ` +
          "you can fix it and publish it again. Buyers won't be able to see or " +
          "buy it in the meantime, and it starts over with no listing age or " +
          "watchers."
        : `"${name}" shows as a draft here but is still linked to an eBay ` +
          "listing, which is what stops the item being deleted. We'll end that " +
          "listing on eBay if it's still live, and mark it ended here either " +
          "way. If eBay says it is still live, we'll refuse and tell you rather " +
          "than marking it ended behind your back.",
      confirmLabel: isLiveListing ? "End listing" : "End & unlink",
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await endListing.mutateAsync({ listingId: listing.id });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(res.note ?? "Ended on eBay — this item is back in Drafts.");
    } catch (err) {
      toast.error(`Couldn't end this listing: ${errorMessage(err)}`);
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

  // US-2960: a derived block's "go to field" control. The block itself has
  // nothing to edit — the fix is the field it reads — so this scrolls that card
  // into view AND puts the cursor in its first real input. Scrolling alone
  // leaves the seller looking at the right card with no idea which box moved
  // the number they came to change.
  function focusSection(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    const self =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
        ? el
        : null;
    const target =
      self ??
      el.querySelector<HTMLElement>(
        "input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled])",
      );
    target?.focus({ preventScroll: true });
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
      // Item first, for the reason saveDraft spells out: the listing row records
      // the aspects as column-derived, so it must not claim that before the write
      // that actually fills the columns has succeeded.
      // Mirror onto the item. Status still comes from resolveStatus (forward-
      // only, and a listed item's earned status can't regress) rather than being
      // skipped — the seller can now move a live item to sold/archived from the
      // same Item details card they use on a draft.
      // US-1995: isLive, so the substitution lands but the listing is flagged
      // for review rather than silently rewritten — buyers are already reading
      // these words. It never ends and relists; the revise-in-place path below
      // is the only way a live title moves on eBay.
      // US-2593: hoisted above the item write for the same reason as saveDraft —
      // the item patch carries the title, and it must be the substituted one.
      const titlePatch = titleSyncPatchFor(true);
      const itemPatch = composerItemPatch(
        state.resolvedAspects,
        state.resolvedSources,
        titlePatch,
      );
      const { error: sErr } = await supabase
        .from("inventory_items")
        .update(itemPatch as never)
        .eq("id", item.id);
      if (sErr) {
        // US-2445: same recovery as the draft path. This one matters more — a
        // LIVE listing whose title edit is dropped goes on to be pushed to eBay
        // by handleResubmitClick, so buyers keep reading the old words and the
        // synced sheet agrees with them.
        if (
          await skuMerge.offerSkuMerge(sErr, storageSku, {
            pendingItemPatch: itemPatch,
            retrySave: saveLiveListing,
          })
        )
          return null;
        throw sErr;
      }
      const { error } = await supabase
        .from("listings")
        .update({ ...buildLiveListingPatch(state), ...titlePatch } as never)
        .eq("id", item.listing_id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["listing", item.listing_id] });
      await qc.invalidateQueries({ queryKey: ["inventory_item_ebay", item.id] });
      markSaved({
        ...syncCascadedCategory(itemPatch),
        ...adoptSyncedTitle(titlePatch),
      });
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
          // US-2684: the quantity was the one eBay-owned field this never sent.
          // The box was on the form, it saved to listings.quantity, and it never
          // reached the offer — so the seller whose listing eBay had left at
          // zero after a cancelled order could resubmit as many times as they
          // liked and it stayed unbuyable. resolveQuantity floors at 1, so this
          // is also what makes Save & resubmit restock on its own.
          quantity: resolveQuantity({ quantity, listingFormat }),
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
      toastError(e, "eBay rejected the update.", {
        duration: 12_000,
        nextStep: "Your changes are saved. Fix what eBay objected to and send it again.",
      });
    }
  }

  // US-2684: put the quantity back, and nothing else.
  //
  // Save & resubmit now carries the quantity too, so this is not the only way
  // out — but it is deliberately the NARROW one. A full resubmit re-asserts the
  // category, the condition, every item specific and the whole photo set, and
  // any one of those can make eBay refuse the call. A seller whose listing is
  // sitting unbuyable does not need the fix for that blocked on a missing
  // Department specific; restocking is one field and should be able to fail for
  // one reason. It also skips the ~5-8s photo round-trip.
  async function handleRestockClick() {
    const listingId = await saveLiveListing();
    if (!listingId) return;
    const nextQty = resolveQuantity({ quantity, listingFormat });
    try {
      await reviseListing.mutateAsync({
        listingId,
        patch: { quantity: nextQty },
      });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["listing", listing?.id] });
      toast.success(
        `Back in stock on eBay — quantity set to ${nextQty}. Buyers can purchase it again.`,
      );
    } catch (err) {
      const e = err as Error & { status?: number };
      toastError(e, "eBay would not restock this listing.", {
        duration: 12_000,
      });
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
        // US-2675: prefer the provenance-carrying form so a chip can say it
        // came from items that SOLD. Falls back to the flat list for drafts
        // generated before migration 00621, which recorded no source at all.
        demandTerms: listing?.demand_terms_detail ?? listing?.demand_terms ?? [],
        aspects: livePickedAspects ?? savedAspects ?? {},
      }),
    [
      title,
      item?.brand,
      listing?.demand_terms,
      listing?.demand_terms_detail,
      livePickedAspects,
      savedAspects,
    ],
  );
  // Merge the existing titleKeywords() chips with the pack suggestions (demand
  // terms + aspects), dropping any token already in the title and de-duping —
  // extends the chips rather than duplicating them (AC2).
  // US-2677: does this draft read like one of the seller's own live listings?
  const titleConflicts = useTitleConflicts(item?.id);
  // US-2679: the quality score, at the top of the surface that can act on it.
  // Keyed on the item id alone, so typing in the title does not re-run a
  // preflight that talks to eBay.
  const listingQuality = useListingQuality(item?.id);
  const titleChips = useMemo<TitleChip[]>(() => {
    const present = new Set(
      title
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(Boolean),
    );
    const seen = new Set<string>();
    const out: TitleChip[] = [];
    for (const chip of [
      ...keywords.map((token): TitleChip => ({ token })),
      ...titleMeter.suggestions.map((s): TitleChip => ({
        token: s.token,
        evidence: s.evidence,
      })),
    ]) {
      const key = chip.token.toLowerCase();
      if (!chip.token.trim() || seen.has(key) || present.has(key)) continue;
      seen.add(key);
      out.push(chip);
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
            <HelpLink slug="writing-a-listing-in-the-composer" label="Help: writing a listing" />
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
      {isLiveListing && !ebayOutOfStock && (
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

      {/* US-2684: the same slot, for the state the green banner used to call
          fine. This one carries the FIX, not just the news — the seller's next
          move is a quantity push and it is one click away, because what cost a
          seller their afternoon here is that the app said LIVE and offered no
          verb that changed anything. */}
      {ebayOutOfStock && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <PackageX className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Live on eBay, but out of stock — nobody can buy it
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300/90">
              eBay set the quantity to zero and left it there. A cancelled order
              does this: eBay takes the quantity down when the order is placed
              and never puts it back. The listing itself is fine, so don't relist
              it — that would create a second one. Restock it instead.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void handleRestockClick()}
              disabled={saving || reviseListing.isPending || !ebayConnection}
              title={
                !ebayConnection
                  ? "Connect eBay first on the Marketplaces page."
                  : "Pushes the quantity above back to the live eBay listing."
              }
            >
              {saving || reviseListing.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <PackageX className="mr-2 h-4 w-4" />
              )}
              Restock on eBay
            </Button>
            {ebayItemUrl && (
              <a
                href={ebayItemUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/10"
              >
                View on eBay ↗
              </a>
            )}
          </div>
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
            onReidentify={() => void handleCompleteWithAi("reidentify")}
            aiEnrichedAt={item.ai_enriched_at}
            sizeMissing={!String(item.size ?? "").trim()}
            sizeEstimating={sizeAi.isPending}
            onEstimateSize={() => void handleEstimateSize()}
            onDuplicate={() => void handleDuplicate()}
            onMarkListed={() => setMarkListedOpen(true)}
            onRelist={() => void handleRelist()}
            onEndListing={() => void handleEndListing()}
            showMarkListed={!item.listing_id && item.status !== "listed"}
            showRelist={item.status === "archived" || item.status === "returned"}
            // Same gate as "Save & resubmit": if there is something live enough
            // to push edits to, there is something to end.
            showEndListing={canEndListing}
            endingListing={endListing.isPending}
            busy={saving}
          />

          <QualityCard
            score={listingQuality.data ?? null}
            onFocusSurface={(anchorId) => {
              const el = document.getElementById(anchorId);
              if (!el) return;
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              // Focus as well as scroll, so a keyboard user lands IN the field
              // rather than merely looking at it.
              if (
                el instanceof HTMLInputElement ||
                el instanceof HTMLSelectElement ||
                el instanceof HTMLTextAreaElement ||
                el instanceof HTMLButtonElement
              ) {
                el.focus({ preventScroll: true });
              }
            }}
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
            garment={measurementGarment}
            gender={itemDepartment}
            measurements={measurements}
            setMeasurements={applyMeasurements}
            onSizeChange={handleSizeChange}
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
            titleConflicts={titleConflicts.data ?? []}
            runDifferentiate={(titles) => void runRewrite("title_differentiate", titles)}
            listingCopy={listingCopy}
            runListingCopy={() => void runListingCopy()}
            isEbayOrigin={isEbayOrigin}
            ebayOwnedHint={ebayOwnedHint}
            saveState={titleSaveState}
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
            // US-2426: US-2424 already scored and stored these at generation
            // time; the picker renders them as one-click alternatives.
            categoryCandidates={listing?.category_candidates ?? null}
            initialised={initialised}
            measurements={measurements}
            setMeasurements={applyMeasurements}
            measurementUnit={measurementUnit}
            itemAspectSource={itemAspectSource}
            onCategoryChange={(id, path) => {
              setLivePickedCategoryId(id);
              setLivePickedCategoryPath(path ?? null);
            }}
            onResolvedCategoryPath={setResolvedCategoryPath}
            onAspectsChange={handleAspectsChange}
            onUserEdit={() => {
              sellerEditedAspects.current = true;
            }}
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
            aiSnapshot={aiSnapshot}
            isEbayOrigin={isEbayOrigin}
            ebayOwnedHint={ebayOwnedHint}
            priceSaveState={priceSaveState}
            priceIsLive={priceIsLive}
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

          {/* US-2877: the seller's OWN saved presets. Distinct from the
              garment template DescriptionCard applies below -- that one is our
              boilerplate, this one is theirs, and iOS has had it since
              US-674. */}
          <SavedTemplatePicker
            current={{
              description,
              ebayCondition,
              conditionDescription: conditionDesc,
              categoryId: resolvedCategoryId ?? "",
              shippingPolicyId: shippingPolicyId ?? "",
              paymentPolicyId: paymentPolicyId ?? "",
              returnPolicyId: returnPolicyId ?? "",
            }}
            onApply={(patch, specifics, template) => {
              if (patch.description !== undefined) {
                applyDescriptionText(patch.description);
              }
              if (patch.ebayCondition !== undefined) setEbayCondition(patch.ebayCondition);
              if (patch.conditionDescription !== undefined) {
                setConditionDesc(patch.conditionDescription);
              }
              if (patch.categoryId !== undefined) setLivePickedCategoryId(patch.categoryId);
              if (patch.shippingPolicyId !== undefined) {
                setShippingPolicyId(patch.shippingPolicyId);
              }
              if (patch.paymentPolicyId !== undefined) {
                setPaymentPolicyId(patch.paymentPolicyId);
              }
              if (patch.returnPolicyId !== undefined) {
                setReturnPolicyId(patch.returnPolicyId);
              }
              // Item specifics merge the same way: an aspect the seller has
              // already picked keeps its value.
              const merged = { ...livePickedAspects };
              for (const [name, value] of Object.entries(specifics)) {
                if (!merged[name]?.length) merged[name] = [value];
              }
              setLivePickedAspects(merged);
              toast.success(`Used "${template.name}".`);
            }}
          />

          <DescriptionCard
            blocks={descriptionBlocks.blocks}
            onBlocksChange={descriptionBlocks.setBlocks}
            preview={descriptionBlocks.preview}
            previewPending={descriptionBlocks.previewPending}
            previewAvailable={!!item.listing_id && descriptionBlocks.ready}
            blocksLoading={descriptionBlocks.loading}
            unavailable={
              !!item.listing_id &&
              !descriptionBlocks.ready &&
              !descriptionBlocks.loading
            }
            converted={descriptionBlocks.converted}
            rowContext={blockRowContext}
            onRegenerate={(key) => void descriptionBlocks.regenerate(key)}
            regenerating={descriptionBlocks.regenerating}
            onGoToField={focusSection}
            group={group}
            applyTemplate={applyTemplate}
            photoCount={photos.length}
            aiRewrite={aiRewrite}
            rewriteAction={rewriteAction}
            runRewrite={(a) => void runRewrite(a)}
            aiSnapshot={aiSnapshot}
            onRevertToAi={applyDescriptionText}
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

      {/* US-2641: relist mode when this item HAS been on eBay before — an ended
          listing, or a live one being replaced. The Listings page has passed
          this since US-560; the composer never did, and the composer is where a
          seller actually relists ("end it, fix it, publish again" all happen on
          this page). Without the flag the server skips the withdraw-first step
          and re-publishes the OLD offer, which after a seller-side end on eBay
          answers 25001 forever or adopts the ended listing's id and reports
          success — the relist that says it worked and links to the listing you
          just ended. `listing` is this item's own row, so a never-listed draft
          still publishes normally. */}
      <PublishToEbayDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        itemId={item.id}
        relist={
          listing?.listing_status === "ended" ||
          listing?.listing_status === "active"
        }
        listingActive={listing?.listing_status === "active"}
      />

      {/* US-552: review/accept the AI rewrite — reuses the extract panel so
          accept-all, confidence tiers, and acceptance logging all carry over.
          US-2442: the listing-copy generator lands here too, translated into the
          same shape. One panel means the seller reviews generated copy exactly
          as they review a rewrite, and a field they already filled arrives with
          its accept switch OFF and a "Replaces current value" line, which is
          what makes the two-field write safe to offer on a filled form. */}
      <AiFillPanel
        open={aiCopyPanelOpen}
        onOpenChange={setAiCopyPanelOpen}
        result={aiCopyResult}
        currentValues={{ title, description }}
        fieldLabels={{ title: "Title", description: "Description" }}
        onApply={(accepted) =>
          applyAiCopy(accepted, "AI copy applied. Save the draft to keep it.")
        }
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
          // US-2445: no hand-listed extraPatch. The save that collided is
          // re-run in full after the merge, so every column it was writing is
          // restored — this used to name two of them and drop the rest.
          onConfirm={(overrides) => void skuMerge.confirmMerge(overrides)}
        />
      )}
    </div>
  );
}
