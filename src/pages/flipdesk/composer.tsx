import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  Wand2,
  Save,
  Loader2,
  Plus,
  Award,
  Star,
  GripVertical,
  Rocket,
  Sparkles,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  COMMON_TIMEZONES,
  DROP_PRESETS,
  detectTimezone,
  formatInZone,
  nextPresetUtc,
} from "@/lib/scheduling";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useItemsFull } from "@/hooks/use-items-full";
import {
  DESCRIPTION_TEMPLATES,
  interpolateDescription,
  suggestTitle,
  titleKeywords,
  templateGroupFor,
} from "@/lib/listing-templates";
import {
  CROSS_LISTING_PLATFORMS,
  EBAY_CONDITION_OPTIONS,
  LIVE_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_LABELS,
  type CrossListingPlatform,
} from "@/lib/constants";
import { resolveStatus, factsOf } from "@/lib/workflow";
import { cn, isoToLocalInput, localInputToIso } from "@/lib/utils";
import { estimateListingProfit } from "@/lib/listing-profit";
import { itemPhotoThumb } from "@/lib/images";
import {
  mapEbayCondition,
  type ItemAspectSource,
} from "@/lib/ebay-prefill";
import { EbayCategoryPicker } from "@/components/flipdesk/ebay-category-picker";
import { AiDiffChip } from "@/components/flipdesk/ai-diff-chip";
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
  aiPriceInput,
  conditionLabel,
  formatAiPrice,
  priceChanged,
  textChanged,
} from "@/lib/listing-ai-diff";
import { EbayCompsPanel } from "@/components/flipdesk/ebay-comps-panel";
import { PublishToEbayDialog } from "@/components/flipdesk/publish-to-ebay-dialog";
import { ListingKit } from "@/components/flipdesk/listing-kit";
import { EbayViewItemPreview } from "@/components/flipdesk/ebay-view-item-preview";
import {
  ListingFormatControls,
  type ListingFormatValue,
} from "@/components/flipdesk/listing-format-controls";
import { useEbayConnection, useEbayPolicies } from "@/hooks/use-ebay";
import { useCrossPush } from "@/hooks/use-cross-listing";
import { useSellThroughForecast } from "@/hooks/use-forecast";
import type {
  ItemPhotoRow,
  ListingInsert,
  ListingRow,
} from "@/types/database";

const TITLE_MAX = 80;

// US-568: composer default — fixed-price, no auction terms, single SKU.
const DEFAULT_LISTING_FORMAT_VALUE: ListingFormatValue = {
  format: "fixed_price",
  auctionStartPrice: "",
  auctionReservePrice: "",
  auctionBuyItNowPrice: "",
  auctionDuration: "DAYS_7",
  variations: null,
};

// US-568: turn the composer's format editor state into the listings columns.
// Dollar strings convert to integer cents; auction columns null out for
// fixed-price drafts, and variations null out for auctions / empty matrices.
function buildFormatPayload(v: ListingFormatValue): Partial<ListingInsert> {
  const dollarsToCents = (s: string): number | null => {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
  };
  const isAuction = v.format === "auction";
  return {
    listing_format: v.format,
    auction_start_price_cents: isAuction
      ? dollarsToCents(v.auctionStartPrice)
      : null,
    auction_reserve_price_cents: isAuction
      ? dollarsToCents(v.auctionReservePrice)
      : null,
    auction_buy_it_now_price_cents: isAuction
      ? dollarsToCents(v.auctionBuyItNowPrice)
      : null,
    auction_duration: isAuction ? v.auctionDuration : null,
    // Variations only apply to fixed-price listings; drop empty matrices.
    variations:
      !isAuction && v.variations && v.variations.variants.length > 0
        ? v.variations
        : null,
  };
}

export function FlipdeskComposerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ebayCondition, setEbayCondition] = useState("");
  const [conditionDesc, setConditionDesc] = useState("");
  const [price, setPrice] = useState("");
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
  const [order, setOrder] = useState<ItemPhotoRow[]>([]);
  const [primaryPhotoId, setPrimaryPhotoId] = useState<string | null>(null);
  const [badgeEnabled, setBadgeEnabled] = useState(false);
  // US-561: Promoted Listings. promoteEnabled mirrors !promo_opt_out (promote by
  // default); promoRate is the seller's accepted/adjusted ad rate (%) seeded
  // from the category suggestion; promoSuggested holds the fetched suggestion so
  // the seller can revert to it.
  const [promoteEnabled, setPromoteEnabled] = useState(true);
  const [promoRate, setPromoRate] = useState("");
  const [promoSuggested, setPromoSuggested] = useState<number | null>(null);
  // US-568: listing format (fixed/auction), auction terms, and variation matrix.
  const [listingFormat, setListingFormat] = useState<ListingFormatValue>(
    DEFAULT_LISTING_FORMAT_VALUE,
  );
  const [saving, setSaving] = useState(false);
  const [initialised, setInitialised] = useState(false);
  // Lifted from the category picker so the comps panel reacts to a pick
  // before the user commits via "Save eBay specifics".
  const [livePickedCategoryId, setLivePickedCategoryId] = useState<
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

  // Shared items_full read — single source of truth across FlipDesk (US-419).
  const { data: items = [], isLoading } = useItemsFull();

  const item = useMemo(
    () => items.find((it) => it.id === id) ?? null,
    [items, id],
  );

  const { data: photos = [] } = useQuery({
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
      ai_generated_aspects_at: string | null;
      color: string | null;
      material: string | null;
    } | null> => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select(
          "ebay_category_id, ebay_aspects, ai_generated_aspects_at, color, material",
        )
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as {
        ebay_category_id: string | null;
        ebay_aspects: Record<string, string[]> | null;
        ai_generated_aspects_at: string | null;
        color: string | null;
        material: string | null;
      } | null;
    },
  });

  // Structured item columns the aspect prefill can draw from — memoized so the
  // picker's seed effect doesn't churn on every render.
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
          }
        : null,
    [item, ebayMapping],
  );

  // Keep the local drag order in sync with fetched photos.
  useEffect(() => {
    setOrder(photos);
  }, [photos]);

  // Seed editable fields once the item, photos, and listing have settled.
  // Everything the item already knows is carried in (description, condition
  // notes, grade-derived condition, target price) so the composer never asks
  // the user to re-enter data — they review and adjust instead.
  useEffect(() => {
    if (initialised || !item) return;
    if (item.listing_id && !listing) return; // wait for the listing fetch
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
    setPriceEstimated(listing?.price_is_estimated ?? false);
    setPriceCompSource(listing?.price_comp_source ?? null);
    setScheduledAt(isoToLocalInput(listing?.scheduled_publish_at ?? null));
    setBadgeEnabled(listing?.badge_enabled ?? false);
    // US-561: promote by default unless this listing explicitly opted out. Seed
    // the rate from the seller's saved value; the suggestion effect fills it in
    // once the resolved category is known (when no saved rate exists yet).
    setPromoteEnabled(!(listing?.promo_opt_out ?? false));
    setPromoRate(
      listing?.promo_rate_pct != null ? String(listing.promo_rate_pct) : "",
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
    const seededPrimary =
      listing?.primary_photo_id &&
      photos.some((p) => p.id === listing.primary_photo_id)
        ? listing.primary_photo_id
        : (photos[0]?.id ?? null);
    setPrimaryPhotoId(seededPrimary);
    setInitialised(true);
  }, [initialised, item, listing, photos]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // US-561: the category that publish will use, for the Promoted Listings ad-rate
  // suggestion (mirrors the resolution order in saveDraft / assemblePublishContext).
  const resolvedCategoryId =
    livePickedCategoryId ??
    listing?.platform_category_id ??
    ebayMapping?.ebay_category_id ??
    null;

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

  const keywords = item ? titleKeywords(item) : [];
  const group = item ? templateGroupFor(item) : "generic";
  const primaryPhoto =
    order.find((p) => p.id === primaryPhotoId) ?? order[0] ?? null;
  const resolvedDescription = item
    ? interpolateDescription(description, item)
    : description;

  const specifics = useMemo(() => {
    if (!item) return [] as { label: string; value: string }[];
    const rows: { label: string; value: string | null }[] = [
      { label: "Brand", value: item.brand },
      { label: "Style", value: item.style },
      { label: "Size", value: item.size },
      { label: "Category", value: item.category },
      {
        label: "Condition",
        value: item.grade_label ?? "Pre-owned",
      },
    ];
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
  }, [item]);

  // US-551: the AI's original draft, snapshotted at generation. Drives the
  // per-field diff chips + revert-to-AI. Null for manually-created drafts.
  const aiSnapshot = listing?.ai_generated_snapshot ?? null;

  function applyTemplate() {
    if (!item) return;
    setDescription(interpolateDescription(DESCRIPTION_TEMPLATES[group], item));
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
        description,
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
      else if (f.field === "description") setDescription(f.value);
    }
    if (accepted.length > 0) {
      toast.success("AI rewrite applied. Save the draft to keep it.");
    }
  }

  async function persistOrder(next: ItemPhotoRow[]) {
    try {
      await Promise.all(
        next.map((p, i) =>
          supabase
            .from("item_photos")
            .update({ sort_order: i } as never)
            .eq("id", p.id),
        ),
      );
      await qc.invalidateQueries({ queryKey: ["item_photos", id] });
    } catch {
      toast.error("Failed to save the new photo order.");
      await qc.invalidateQueries({ queryKey: ["item_photos", id] });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.findIndex((p) => p.id === active.id);
    const newIndex = order.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next); // optimistic
    void persistOrder(next);
  }

  // Per-listing opt-in for the grade-badge + certificate-link promotion. The
  // badge is now burned SERVER-SIDE at publish (flipdesk-ebay.ts) onto the hero
  // photo, and the certificate link is appended to the description — so the
  // toggle just records the choice (persisted via badge_enabled on save) and the
  // preview column shows an approximation. No upload happens here, which also
  // avoids double-badging the image the server later badges.
  function toggleBadge(next: boolean) {
    setBadgeEnabled(next);
  }

  // Persists the draft. Returns the listing row's id on success (so the
  // publish flow can save-then-push in one click), null on failure. By
  // default the user STAYS on the composer — the publish CTA lives here, so
  // navigating away after save (the old behavior) forced a detour through
  // the Drafts list to publish.
  async function saveDraft(): Promise<string | null> {
    if (!item) return null;
    if (!title.trim()) {
      toast.error("Title is required.");
      return null;
    }
    setSaving(true);
    try {
      const parsedPrice = Number.parseFloat(price);
      // First POSITIVE price wins (mirrors the seed logic) — never persist a
      // 0 that would later shadow the item's target price at publish.
      const resolvedPrice =
        [
          Number.isFinite(parsedPrice) ? parsedPrice : null,
          item.target_price,
          item.list_price,
        ].find((p): p is number => p != null && p > 0) ?? 0;
      // US-557: ONE coherent save. The category picker reports its live aspect
      // map up via onAspectsChange; here we write it to BOTH the listing
      // override (item_specifics_override — the per-listing canonical copy
      // publish reads first) AND the inventory mirror (ebay_aspects — the
      // fallback) in the same save, so the two stores never diverge and a
      // picker edit can't vanish by skipping a separate save. Fall back to the
      // saved values when the picker hasn't reported yet.
      const resolvedCategoryId =
        livePickedCategoryId ??
        listing?.platform_category_id ??
        ebayMapping?.ebay_category_id ??
        null;
      const liveAspects =
        livePickedAspects ??
        listing?.item_specifics_override ??
        ebayMapping?.ebay_aspects ??
        null;
      const resolvedAspects =
        liveAspects && Object.keys(liveAspects).length > 0 ? liveAspects : null;
      const payload: ListingInsert = {
        inventory_item_id: item.id,
        platform: "ebay",
        listing_status: "draft",
        listing_price: resolvedPrice,
        listing_title: title.trim(),
        listing_description: description.trim() || null,
        ebay_condition: ebayCondition || null,
        ebay_condition_description: conditionDesc.trim() || null,
        platform_category_id: resolvedCategoryId,
        item_specifics_override: resolvedAspects,
        scheduled_publish_at: localInputToIso(scheduledAt),
        // Saving = a human reviewed the price, so it's no longer an unverified
        // AI estimate.
        price_is_estimated: false,
        is_active: false,
        primary_photo_id: primaryPhotoId,
        badge_enabled: badgeEnabled,
        // US-561: persist the Promoted Listings choice. Opt-out when the toggle
        // is off; otherwise store the accepted/adjusted rate (a blank box falls
        // back to the category suggestion at publish, so persist null then).
        promo_opt_out: !promoteEnabled,
        promo_rate_pct: promoteEnabled
          ? (() => {
              const r = Number.parseFloat(promoRate);
              return Number.isFinite(r) && r > 0 ? r : null;
            })()
          : null,
        // US-568: persist format + auction terms + variation matrix. Auction
        // prices convert dollars → cents; null when blank or non-auction.
        ...buildFormatPayload(listingFormat),
      };

      let listingId: string;
      if (item.listing_id && item.listing_status === "draft") {
        const { error } = await supabase
          .from("listings")
          .update(payload as never)
          .eq("id", item.listing_id);
        if (error) throw error;
        listingId = item.listing_id;
      } else {
        const { data: created, error } = await supabase
          .from("listings")
          .insert(payload as never)
          .select("id")
          .single();
        if (error) throw error;
        listingId = (created as { id: string }).id;
      }

      // Forward-only: never regress a listed/sold item back to "drafted".
      const resolvedStatus = resolveStatus(item.status, "drafted", {
        ...factsOf(item),
        hasDraftListing: true,
      });
      // Mirror the category + aspects onto the item in the same save so the
      // inventory store stays in lockstep with the listing override (US-557).
      const { error: sErr } = await supabase
        .from("inventory_items")
        .update({
          status: resolvedStatus,
          ebay_category_id: resolvedCategoryId,
          ebay_aspects: resolvedAspects,
        } as never)
        .eq("id", item.id);
      if (sErr) throw sErr;

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["listing", item.listing_id] });
      await qc.invalidateQueries({
        queryKey: ["inventory_item_ebay", item.id],
      });
      toast.success("Draft saved.");
      return listingId;
    } catch (err) {
      toast.error(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      setSaving(false);
    }
  }

  function togglePushPlatform(platform: CrossListingPlatform) {
    setPushPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  }

  // Publish reads the DATABASE, not the form — so save first, then push. One
  // click instead of save → back out → Drafts list → Publish. eBay-only keeps
  // the preflight dialog; any other selection dispatches through cross-push
  // (US-149), which fans the draft out to one listings row per platform.
  async function handlePublishClick() {
    const listingId = await saveDraft();
    if (!listingId) return;

    const platforms = [...pushPlatforms];
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
      toast.error(
        `Cross-listing push failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  const parsedPreviewPrice = Number.parseFloat(price);
  const previewPrice = Number.isFinite(parsedPreviewPrice)
    ? parsedPreviewPrice
    : (item.target_price ?? item.list_price ?? null);
  // US-553: forward profit/margin at the current list price.
  const profitEstimate = estimateListingProfit({
    price: Number.isFinite(parsedPreviewPrice) ? parsedPreviewPrice : 0,
    costBasis: item.purchase_price,
    shippingCost: item.shipping_cost,
  });
  const showBadgeOverlay = badgeEnabled && item.grade_value != null;

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
  const shippingPolicyName = policyName(
    "fulfillment",
    ebayPolicies?.defaults.fulfillment_policy_id ?? null,
  );
  const returnPolicyName = policyName(
    "return",
    ebayPolicies?.defaults.return_policy_id ?? null,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Listing composer
          </h1>
          <p className="text-sm text-muted-foreground">
            Build, preview, and pick photo variants for "{item.item_title}".
          </p>
        </div>
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
            {item.grade_label ? ` · ${item.grade_label}` : ""}. Enable the grade
            badge below to publish with the badge on the hero photo and a
            certificate link in the description.
          </span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Editor column ───────────────────────────────────────── */}
        <div className="space-y-6">
          {/* Title */}
          <Card>
            <CardHeader>
              <CardTitle>Title</CardTitle>
              <CardDescription>
                eBay caps titles at {TITLE_MAX} characters. Lead with the brand.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative">
                <Input
                  value={title}
                  maxLength={TITLE_MAX}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Brand Item Size Category"
                />
                <span
                  className={cn(
                    "absolute right-2 top-1/2 -translate-y-1/2 text-[10px] tabular-nums",
                    titleLen >= TITLE_MAX
                      ? "font-semibold text-destructive"
                      : titleLen > 70
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground",
                  )}
                >
                  {titleLen}/{TITLE_MAX}
                </span>
              </div>
              {aiSnapshot && (
                <AiDiffChip
                  changed={textChanged(aiSnapshot.title, title)}
                  aiDisplay={aiSnapshot.title ?? ""}
                  onRevert={() => setTitle((aiSnapshot.title ?? "").slice(0, TITLE_MAX))}
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTitle(suggestTitle(item))}
                >
                  <Wand2 className="mr-2 h-3 w-3" />
                  Suggest title
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!title.trim() || aiRewrite.isPending}
                    >
                      {aiRewrite.isPending &&
                      rewriteAction?.startsWith("title_") ? (
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="mr-2 h-3 w-3" />
                      )}
                      AI rewrite
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => void runRewrite("title_seo")}>
                      Punch up for SEO
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void runRewrite("title_shorten")}
                    >
                      Shorten to 80
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void runRewrite("title_keywords")}
                    >
                      Add buyer keywords
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {keywords.map((kw) => (
                  <button
                    key={kw}
                    type="button"
                    onClick={() => appendKeyword(kw)}
                    className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
                  >
                    <Plus className="h-3 w-3" />
                    {kw}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* eBay category + item specifics — prefer the listing-row override
              when present (the editor / bulk-edit writes here), then fall
              back to the inventory_items mirror for legacy single-item flows.
              US-557: gate the mount until both saved sources have loaded, so the
              picker seeds its (now lifted) aspect state from the real values —
              never from a transient empty map that a save would persist as a
              wipe. */}
          {listingLoading || ebayMappingLoading ? (
            <Card>
              <CardContent className="py-6">
                <LoadingRegion label="Loading eBay item specifics">
                  <SkeletonRows rows={4} />
                </LoadingRegion>
              </CardContent>
            </Card>
          ) : (
            <EbayCategoryPicker
              itemId={item.id}
              initialCategoryId={
                listing?.platform_category_id ??
                ebayMapping?.ebay_category_id ??
                null
              }
              initialAspects={
                listing?.item_specifics_override ??
                ebayMapping?.ebay_aspects ??
                null
              }
              seedQuery={item.item_title ?? ""}
              itemFields={itemAspectSource}
              onCategoryChange={setLivePickedCategoryId}
              onAspectsChange={setLivePickedAspects}
            />
          )}

          {/* Live comps + price recommendation */}
          <EbayCompsPanel
            itemId={item.id}
            categoryId={
              livePickedCategoryId ??
              listing?.platform_category_id ??
              ebayMapping?.ebay_category_id ??
              null
            }
            brand={item.brand ?? null}
            size={item.size ?? null}
            q={item.item_title ?? ""}
            grade={item.grade_value ?? null}
          />

          {/* Condition & price */}
          <Card>
            <CardHeader>
              <CardTitle>Condition &amp; price</CardTitle>
              <CardDescription>
                The eBay condition and starting price for this listing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="ebay-condition">eBay condition</Label>
                <select
                  id="ebay-condition"
                  value={ebayCondition}
                  onChange={(e) => setEbayCondition(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">Select condition…</option>
                  {EBAY_CONDITION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {aiSnapshot && (
                  <AiDiffChip
                    changed={textChanged(aiSnapshot.ebay_condition, ebayCondition)}
                    aiDisplay={conditionLabel(aiSnapshot.ebay_condition)}
                    onRevert={() => setEbayCondition(aiSnapshot.ebay_condition ?? "")}
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="condition-desc">Condition description</Label>
                <Textarea
                  id="condition-desc"
                  value={conditionDesc}
                  onChange={(e) => setConditionDesc(e.target.value)}
                  rows={3}
                  placeholder="Honest, buyer-facing condition notes — call out any flaws."
                />
                {aiSnapshot && (
                  <AiDiffChip
                    changed={textChanged(
                      aiSnapshot.condition_description,
                      conditionDesc,
                    )}
                    aiDisplay={aiSnapshot.condition_description ?? ""}
                    onRevert={() =>
                      setConditionDesc(aiSnapshot.condition_description ?? "")
                    }
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="listing-price">Price (USD)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="listing-price"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={price}
                    onChange={(e) => {
                      setPrice(e.target.value);
                      setPriceEstimated(false);
                      setPriceCompSource(null);
                    }}
                    placeholder="0.00"
                    className="max-w-[10rem]"
                  />
                  {priceEstimated && (
                    <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
                      {priceCompSource === "active_asking"
                        ? "Asking-price comp — may run high"
                        : "AI estimate — verify"}
                    </Badge>
                  )}
                  {aiSnapshot && (
                    <AiDiffChip
                      changed={priceChanged(aiSnapshot.price_cents, price)}
                      aiDisplay={formatAiPrice(aiSnapshot.price_cents)}
                      onRevert={() => {
                        setPrice(aiPriceInput(aiSnapshot.price_cents));
                        setPriceEstimated(true);
                        setPriceCompSource(null);
                      }}
                    />
                  )}
                </div>
                {priceEstimated && (
                  <p className="text-xs text-muted-foreground">
                    {priceCompSource === "active_asking"
                      ? "No sold comps were available, so this price is based on active eBay asking prices, which tend to run high. Verify before publishing."
                      : "No eBay comps were found, so this price is the AI's estimate. Edit it to confirm."}
                  </p>
                )}
                {/* US-553: live profit/margin so pricing is a margin decision. */}
                {parsedPreviewPrice > 0 && (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Est. net profit</span>
                      <span
                        className={cn(
                          "font-semibold tabular-nums",
                          profitEstimate.net < 0
                            ? "text-destructive"
                            : profitEstimate.marginPct < 20
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-emerald-600 dark:text-emerald-400",
                        )}
                      >
                        ${profitEstimate.net.toFixed(2)} ·{" "}
                        {profitEstimate.marginPct.toFixed(0)}% margin
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>eBay fees ~${profitEstimate.fees.toFixed(2)}</span>
                      <span>Cost ${(item.purchase_price ?? 0).toFixed(2)}</span>
                      {(item.shipping_cost ?? 0) > 0 && (
                        <span>Shipping ${(item.shipping_cost ?? 0).toFixed(2)}</span>
                      )}
                    </div>
                    {item.purchase_price == null && (
                      <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                        Add this item's cost to see true margin.
                      </p>
                    )}
                  </div>
                )}
                {/* US-623: condition-aware sell-through forecast at this price. */}
                {sellThroughForecast && sellThroughForecast.label !== "unknown" && parsedPreviewPrice > 0 && (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Est. sell-through</span>
                      <span
                        className={cn(
                          "font-semibold tabular-nums",
                          sellThroughForecast.label === "fast"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : sellThroughForecast.label === "moderate"
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground",
                        )}
                      >
                        ~{Math.round(sellThroughForecast.sellThroughPct * 100)}% in{" "}
                        {sellThroughForecast.daysLow}–{sellThroughForecast.daysHigh} days
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Estimate from {sellThroughForecast.sampleSize} condition-matched comps — a lower price sells faster.
                    </p>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-at">Schedule publish (optional)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="schedule-at"
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="max-w-[16rem]"
                  />
                  {scheduledAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setScheduledAt("")}
                    >
                      Clear
                    </Button>
                  )}
                </div>
                {/* US-563: timezone-aware peak-time presets. The picker only
                    controls how the presets below are evaluated; the input
                    stays in your browser's local time. */}
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <Select value={dropTimezone} onValueChange={setDropTimezone}>
                    <SelectTrigger className="h-8 w-[15rem] text-xs">
                      <SelectValue placeholder="Timezone" />
                    </SelectTrigger>
                    <SelectContent>
                      {(COMMON_TIMEZONES.some((t) => t.id === dropTimezone)
                        ? COMMON_TIMEZONES
                        : [{ id: dropTimezone, label: `${dropTimezone} (your timezone)` }, ...COMMON_TIMEZONES]
                      ).map((tz) => (
                        <SelectItem key={tz.id} value={tz.id} className="text-xs">
                          {tz.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {DROP_PRESETS.map((preset) => (
                    <Button
                      key={preset.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      title={preset.hint}
                      onClick={() => {
                        const utc = nextPresetUtc(preset, dropTimezone);
                        setScheduledAt(isoToLocalInput(utc.toISOString()));
                        toast.success(
                          `Drop set for ${formatInZone(utc.toISOString(), dropTimezone)}`,
                        );
                      }}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Leave empty to publish immediately when you hit “Publish”.
                  If set, save the draft and it goes live automatically at that time.
                  {scheduledAt && (
                    <>
                      {" "}Goes live{" "}
                      <span className="font-medium text-foreground">
                        {formatInZone(
                          localInputToIso(scheduledAt) ?? "",
                          dropTimezone,
                        )}
                      </span>
                      .
                    </>
                  )}
                </p>
              </div>
            </CardContent>
          </Card>

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

          {/* Promoted Listings ad rate (US-561) */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Promote on eBay</CardTitle>
                  <CardDescription>
                    Attach a Promoted Listings ad rate at publish for more
                    visibility. You’re only charged this % of the sale price
                    when the item sells through the ad.
                  </CardDescription>
                </div>
                <Switch
                  id="promote-toggle"
                  checked={promoteEnabled}
                  onCheckedChange={setPromoteEnabled}
                  aria-label="Promote this listing on eBay"
                />
              </div>
            </CardHeader>
            {promoteEnabled && (
              <CardContent className="space-y-2">
                <Label htmlFor="promo-rate">Ad rate (%)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="promo-rate"
                    type="number"
                    inputMode="decimal"
                    min="2"
                    max="20"
                    step="0.5"
                    value={promoRate}
                    onChange={(e) => setPromoRate(e.target.value)}
                    className="h-9 max-w-[7rem]"
                  />
                  {promoSuggested != null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPromoRate(String(promoSuggested))}
                      disabled={promoRate === String(promoSuggested)}
                    >
                      Use suggested ({promoSuggested}%)
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {promoSuggested != null
                    ? `Suggested ${promoSuggested}% for this category. Adjust between 2% and 20%, or turn off to opt out.`
                    : "Adjust between 2% and 20%, or turn off to opt out."}
                </p>
                {listing?.promo_status === "failed" && (
                  <p className="text-xs text-destructive">
                    The last publish couldn’t attach the ad on eBay. It’ll retry
                    on your next publish.
                  </p>
                )}
                {listing?.promo_ad_id && listing.promo_status &&
                  listing.promo_status !== "failed" && (
                    <p className="text-xs text-muted-foreground">
                      Live ad status:{" "}
                      <span className="font-medium">{listing.promo_status}</span>
                      {listing.promo_rate_pct != null
                        ? ` at ${listing.promo_rate_pct}%`
                        : ""}
                      .
                    </p>
                  )}
              </CardContent>
            )}
          </Card>

          {/* Push to marketplaces (US-149) */}
          <Card>
            <CardHeader>
              <CardTitle>Push to</CardTitle>
              <CardDescription>
                Cross-list this draft to multiple marketplaces. Each platform
                gets its own price — leave it blank to use the price above.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {CROSS_LISTING_PLATFORMS.map((p) => {
                const checked = pushPlatforms.has(p);
                return (
                  <div
                    key={p}
                    className="flex items-center justify-between gap-3 rounded-md border p-2.5"
                  >
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePushPlatform(p)}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                      <span className="font-medium">
                        {MARKETPLACE_LABELS[p]}
                      </span>
                      {!(LIVE_CROSS_LISTING_PLATFORMS as readonly string[]).includes(
                        p,
                      ) && (
                        <Badge variant="outline" className="text-[10px]">
                          saved locally — publish coming soon
                        </Badge>
                      )}
                    </label>
                    {checked && (
                      <Input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={platformPrices[p] ?? ""}
                        onChange={(e) =>
                          setPlatformPrices((prev) => ({
                            ...prev,
                            [p]: e.target.value,
                          }))
                        }
                        placeholder={price || "Price"}
                        className="h-8 max-w-[7rem] text-right"
                        aria-label={`${MARKETPLACE_LABELS[p]} price`}
                      />
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Photos */}
          <Card>
            <CardHeader>
              <CardTitle>Photos</CardTitle>
              <CardDescription>
                Drag to reorder. Click the star to choose the primary image.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {order.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">
                  No photos yet — add some from the item's Photos tab first.
                </p>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={order.map((p) => p.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {order.map((photo) => (
                        <ComposerPhoto
                          key={photo.id}
                          photo={photo}
                          isPrimary={photo.id === primaryPhoto?.id}
                          onPickPrimary={() => setPrimaryPhotoId(photo.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}

              <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
                <div className="space-y-0.5">
                  <Label
                    htmlFor="badge-toggle"
                    className="text-sm font-medium"
                  >
                    Add grade badge + certificate link
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {item.grade_value == null
                      ? "Grade this item first to enable the badge."
                      : "On publish, burns the GradeThread badge onto the hero photo and adds a certificate link to the description."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="badge-toggle"
                    checked={badgeEnabled}
                    disabled={
                      item.grade_value == null ||
                      order.length === 0
                    }
                    onCheckedChange={(v) => toggleBadge(v)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Description */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Description</CardTitle>
                  <CardDescription>
                    Apply the{" "}
                    <Badge variant="outline" className="capitalize">
                      {group}
                    </Badge>{" "}
                    template, then edit freely.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={applyTemplate}>
                    <Wand2 className="mr-2 h-3 w-3" />
                    Apply template
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={aiRewrite.isPending}
                      >
                        {aiRewrite.isPending &&
                        rewriteAction?.startsWith("description_") ? (
                          <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 h-3 w-3" />
                        )}
                        AI rewrite
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={!description.trim()}
                        onClick={() => void runRewrite("description_tighten")}
                      >
                        Tighten &amp; polish
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={order.length === 0}
                        onClick={() => void runRewrite("description_regen")}
                      >
                        Regenerate from photos
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={14}
                placeholder="Apply the template above, or write your own."
                className="font-mono text-xs"
              />
              {aiSnapshot?.description && (
                <AiDiffChip
                  changed={textChanged(aiSnapshot.description, description)}
                  aiDisplay="AI draft"
                  onRevert={() => setDescription(aiSnapshot.description ?? "")}
                />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Preview column ──────────────────────────────────────── */}
        <div className="lg:sticky lg:top-4 lg:self-start">
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
                photos={order}
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
                showBadge={showBadgeOverlay}
                gradeValue={item.grade_value}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate(-1)} disabled={saving}>
          Close
        </Button>
        <Button
          variant="outline"
          onClick={saveDraft}
          disabled={saving}
        >
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save draft
        </Button>
        <Button
          onClick={() => void handlePublishClick()}
          disabled={
            saving ||
            crossPush.isPending ||
            pushPlatforms.size === 0 ||
            (pushPlatforms.has("ebay") && !ebayConnection)
          }
          title={
            pushPlatforms.has("ebay") && !ebayConnection
              ? "Connect eBay first on the Marketplaces page."
              : pushPlatforms.size === 0
                ? "Pick at least one marketplace in the Push to card."
                : "Saves the draft, then publishes."
          }
        >
          {crossPush.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Rocket className="mr-2 h-4 w-4" />
          )}
          {pushPlatforms.size === 1 && pushPlatforms.has("ebay")
            ? "Save & publish to eBay"
            : `Save & push to ${pushPlatforms.size} marketplace${
                pushPlatforms.size === 1 ? "" : "s"
              }`}
        </Button>
      </div>

      <ListingKit
        itemId={item.id}
        baseName={item.item_number ?? item.item_title ?? item.id}
      />

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
    </div>
  );
}

function ComposerPhoto({
  photo,
  isPrimary,
  onPickPrimary,
}: {
  photo: ItemPhotoRow;
  isPrimary: boolean;
  onPickPrimary: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: photo.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={cn(
        "relative aspect-square overflow-hidden rounded-md border bg-muted/40",
        isPrimary && "ring-2 ring-brand-navy",
      )}
    >
      <img
        src={itemPhotoThumb(photo)}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
      />
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="absolute left-1 top-1 cursor-grab rounded bg-background/80 p-1 text-muted-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onPickPrimary}
        aria-label={isPrimary ? "Primary photo" : "Set as primary photo"}
        title={isPrimary ? "Primary photo" : "Set as primary photo"}
        className={cn(
          "absolute right-1 top-1 rounded bg-background/80 p-1",
          isPrimary
            ? "text-amber-500"
            : "text-muted-foreground hover:text-amber-500",
        )}
      >
        <Star
          className={cn("h-3.5 w-3.5", isPrimary && "fill-current")}
        />
      </button>
      {isPrimary && (
        <span className="absolute bottom-1 left-1 rounded bg-brand-navy px-1.5 py-0.5 text-[9px] font-semibold text-white">
          Primary
        </span>
      )}
    </div>
  );
}
