import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation, Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  ExternalLink,
  Megaphone,
  Percent,
  RefreshCw,
  Store,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { supabase } from "@/lib/supabase";
import { useItemFull } from "@/hooks/use-items-full";
import {
  useEbayConnection,
  useEbayEndSale,
  useEbayLeaveFeedback,
  useEbayPromotion,
  useEbayRemovePromotion,
  useEbayReviseListing,
  useEbaySetPromotion,
  useEbayStartSale,
  useListingQuality,
} from "@/hooks/use-ebay";
import {
  deriveListingOrigin,
  driftFieldLabel,
  type SyncDriftMarker,
} from "@/lib/listing-origin";
import {
  activeListing,
  ebayListing,
  flaggedListings,
  itemListingsKey,
  useItemListings,
} from "@/hooks/use-item-listings";
import { useItemsList } from "@/hooks/use-items-full";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CrossSurfaceNudge } from "@/components/cross-surface/cross-surface-nudge";
import { FlipdeskComposerPage } from "@/pages/flipdesk/composer";
import { ListingAlertMarkers } from "@/components/flipdesk/listing-alert-markers";
import {
  QualityScoreBreakdown,
  QualityScoreChip,
} from "@/components/flipdesk/quality-score-chip";
import { ConditionIndexValueHint } from "@/components/flipdesk/condition-index-value-hint";
import { GradeRoiHint } from "@/components/flipdesk/grade-roi-hint";
import { GradeOutcomeCard } from "@/components/flipdesk/grade-outcome-card";
import { DisclosurePanel } from "@/components/disclosure/disclosure-panel";
import { RelistSuggestionCard } from "@/components/passport/relist-suggestion-card";
import { gradeRoiHintWouldRender } from "@/lib/flipdesk-analytics";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import { safeHref } from "@/lib/safe-url";

// US-1075: dollar floor for the "grade this to boost trust" cross-surface nudge.
// Below this, the extra grading cost is rarely worth it, so we stay quiet.
const HIGH_VALUE_THRESHOLD = 50;

// Deep-linkable item detail page. The canvas itself is shared with the
// quick-look dialog opened from list rows.
export function FlipdeskItemPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { hash } = location;

  // US-2519: back returns to the list the seller actually came from, with its
  // tab, filters and saved view intact. The inventory surfaces pass their own
  // location in `state.from`; the hardcoded fallback only applies to a cold deep
  // link, where there is no history to return to.
  const backTo =
    (location.state as { from?: string } | null)?.from ??
    "/dashboard/flipdesk/items";

  // US-2188: one row, not the whole catalog. This page renders exactly one
  // item, so it reads exactly one — the shared list read stays projected and
  // this stays the only place that pays for the heavy columns.
  const { data: item = null, isLoading, isError, refetch } = useItemFull(id);

  // US-2519: which group of panels is showing. The editor is the default, so
  // the page still opens on what it is for.
  const [tab, setTab] = useState("details");

  // US-2519: does the data-driven grade hint have something to say? If it does,
  // the value-only nudge stays quiet — two prompts for one action, side by side,
  // reads as a bug. The predicate lives with the component so the two cannot
  // disagree about when it renders.
  const { data: soldHistory = [] } = useItemsList();
  const roiHintShows = item
    ? gradeRoiHintWouldRender(soldHistory, {
        category: item.category,
        grade: item.grade_value,
        priceHint: item.target_price ?? item.list_price ?? item.purchase_price,
      })
    : false;

  // The grade panel lives inside the composer, which is on the Details tab. Both
  // nudges and the #canvas-grading deep link go through here, so switching tab
  // first is done in exactly one place.
  function goToGrading() {
    setTab("details");
    // After the tab has painted, or there is nothing to scroll to yet.
    requestAnimationFrame(() => {
      const el = document.getElementById("canvas-grading");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // Deep links like /items/:id#canvas-grading (US-859 stale-listing "grade it"
  // nudge) should land on the grade section once the item has rendered.
  useEffect(() => {
    if (!hash || !item) return;
    // US-2519: the target may be inside a tab that is not mounted. Selecting it
    // first is what keeps the deep link working now the panels are grouped.
    if (hash === "#canvas-grading") setTab("details");
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash, item]);

  function goBack() {
    navigate(backTo);
  }

  if (isLoading) {
    return (
      <LoadingRegion label="Loading item" className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </LoadingRegion>
    );
  }

  // A FAILED items_full read used to render as "Item not found." — the `= []`
  // default is indistinguishable from a real empty inventory once the query
  // errors. That sent a whole debugging session after a missing row when the
  // actual fault was the shared read throwing. Say which one it is.
  if (isError) {
    return (
      <div className="space-y-3 py-12 text-center">
        <div className="text-sm text-muted-foreground">
          Couldn't load your items. This is a connection problem, not a missing
          item.
        </div>
        <Button variant="outline" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Try again
        </Button>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="space-y-3 py-12 text-center">
        <div className="text-sm text-muted-foreground">Item not found.</div>
        <Button variant="outline" onClick={goBack}>
          Back to items
        </Button>
      </div>
    );
  }

  return (
    // max-w-4xl (896px) capped this page to ~55% of the content area on a 1920px
    // screen, so the composer's two columns sat in a narrow ribbon of dead space.
    // 100rem fills a 1080p desktop edge-to-edge and only starts capping on
    // ultrawide, where unbounded cards would stretch past a comfortable read.
    // The composer itself is container-queried, so it lays itself out to whatever
    // width it actually receives here.
    <div className="mx-auto max-w-[100rem] space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          aria-label="Back to items"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to={backTo} className="hover:text-foreground">
            Items
          </Link>
          <span>/</span>
          <span className="truncate font-medium text-foreground">
            {item.item_title || "Untitled item"}
          </span>
        </nav>
        <Badge variant="outline" className="ml-auto font-normal">
          {ITEM_STATUS_LABELS[item.status]}
        </Badge>
      </div>

      {/* US-2519: ONE grade nudge, never two. Both of these prompt the same
          action and scroll to the same panel, and they used to be able to render
          together — the data-driven one wins when it can, and the value-only one
          covers the case where the seller's sold history is too thin for it. */}
      {!roiHintShows &&
        item.grade_value == null &&
        (item.target_price ?? item.list_price ?? item.purchase_price ?? 0) >=
          HIGH_VALUE_THRESHOLD && (
          <CrossSurfaceNudge
            nudgeId="flipdesk-to-grade"
            icon={BadgeCheck}
            title="Grade this to boost buyer trust"
            description="This is a higher-value item — an independent condition grade reassures buyers and can lift your sale price and speed."
            cta={{
              label: "Grade this item",
              onAction: () => goToGrading(),
            }}
            context={{
              item_id: item.id,
              price_hint:
                item.target_price ?? item.list_price ?? item.purchase_price ?? null,
            }}
          />
        )}

      {/* US-856: the seller's OWN sold history says what grading this is worth. */}
      <GradeRoiHint
        category={item.category}
        grade={item.grade_value}
        priceHint={item.target_price ?? item.list_price ?? item.purchase_price}
        onGrade={goToGrading}
      />

      {/* US-2165 / US-1290: a listing we couldn't end, or an apparent double
          sale. Deliberately ABOVE the tabs and across EVERY platform: both mean
          the same garment can still be bought right now, which is not something
          to hide behind a tab the seller may never open. */}
      <ListingAlertsSection itemId={item.id} />

      {/* US-2519: twelve stacked panels became four groups. The editor is the
          default because it is what the page is for; everything else is a thing
          you go and look at. */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="listing">Listing</TabsTrigger>
          <TabsTrigger value="grade">Grade</TabsTrigger>
          <TabsTrigger value="money">Money</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-6 space-y-6">
          {/* The ONE item editor, at every status — same fields whether this item
              is a draft, live on eBay, or sold. Only the footer actions change.
              The old split (composer for drafts, ItemCanvas here) meant a listed
              item lost the eBay category + item-specifics editor, so saving it
              pushed an incomplete specifics map and eBay rejected the revision. */}
          <FlipdeskComposerPage itemId={item.id} showHeader={false} />

          {/* Auto-Disclosure Engine: condition & flaws + annotated defect photos.
              It edits the listing copy, so it belongs with the editor. */}
          <DisclosurePanel itemId={item.id} />
        </TabsContent>

        <TabsContent value="listing" className="mt-6 space-y-6">
          {/* US-2170: the quality score WITH its breakdown — which lever is weak
              and what fixing it is worth. */}
          <ListingQualityCard itemId={item.id} />

          {/* eBay-NATIVE listings can't be revised through GradeThread. */}
          <EbayNativeNotice itemId={item.id} />

          {/* US-1081: GradeThread-originated live listings — authority badge +
              non-blocking eBay-drift indicator with a "Re-push to eBay". */}
          <GradethreadListingCard itemId={item.id} itemTitle={item.item_title} />

          {/* US-150: per-listing opt-out from the price-drop/promo scheduler. */}
          <AutomationOptOutCard itemId={item.id} />
        </TabsContent>

        <TabsContent value="grade" className="mt-6 space-y-6">
          {/* US-857: once a graded item sells, close the loop — its grade vs the
              realized outcome, plus the account-level rollup. */}
          <GradeOutcomeCard item={item} />

          {/* US-848: grade-anchored value from the public Condition Index. */}
          <ConditionIndexValueHint
            brand={item.brand}
            category={item.category}
            title={item.item_title}
            grade={item.grade_value}
          />

          {/* US-1099: relist detection — if these photos match a garment we have
              already graded, offer to continue its passport chain. */}
          <RelistSuggestionCard itemId={item.id} />
        </TabsContent>

        <TabsContent value="money" className="mt-6 space-y-6">
          <PromotionSaleCard itemId={item.id} />
          <LeaveFeedbackCard itemId={item.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Notice for eBay-NATIVE active listings (created on eBay, no Sell offer):
// those can't be revised through GradeThread, so eBay fields must be edited on
// eBay. GradeThread-PUBLISHED listings are edited + pushed inline via the
// canvas "Save & sync to eBay" button, so this renders nothing for them (or for
// drafts). This replaces the old separate "Update eBay listing" card — the
// unified canvas Save now owns the GradeThread-published sync path.
function EbayNativeNotice({ itemId }: { itemId: string }) {
  const { data: ebayConnection } = useEbayConnection();
  // US-2519: one shared read for the whole page, not a fourth copy of it.
  const { data: rows = [] } = useItemListings(itemId);
  const listing = activeListing(rows);

  if (!ebayConnection || !listing) return null;

  // US-1080: only for eBay-ORIGINATED listings (created on eBay, imported into
  // GradeThread). GradeThread-originated/published listings and drafts render
  // nothing — the canvas + GradethreadListingCard handle those.
  const origin = deriveListingOrigin({
    platform: "ebay",
    platform_listing_id: listing.platform_listing_id,
    batch_id: listing.batch_id,
    synced_to_ebay_at: listing.synced_to_ebay_at,
  });
  if (origin !== "ebay") return null;

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-center gap-2 font-medium">
          <Store className="h-4 w-4 text-brand-red-text" />
          Listed on eBay (created on eBay)
        </div>
        <p className="text-sm text-muted-foreground">
          This listing was created on eBay, not GradeThread, so its eBay fields
          (title, price, description, photos) are owned by eBay and locked in the
          editor below. Your internal FlipDesk fields — grade, notes,
          measurements, and cost — stay editable. To change what buyers see, edit
          it on eBay, or relist it through GradeThread to manage it here.
        </p>
        {safeHref(listing.listing_url) && (
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <a
              href={safeHref(listing.listing_url) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Edit on eBay
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// US-2165 (AC3) + US-1290 (AC3): surface the oversell-risk markers that
// autoEndCrossListings stamps into listings.platform_fields.
//
// Every OTHER listing panel on this page is eBay-only (they query
// .eq("platform","ebay") and bail without an eBay connection). That is precisely
// wrong for these two markers: the platform most likely to carry an unresolved
// delist is the one whose auto-end was never wired — Etsy, before US-2164 — and a
// seller with no eBay connection at all would have seen nothing. So this reads
// EVERY platform's listing for the item, and renders one banner per flagged row.
//
// RLS on listings is owner-scoped through inventory_items, so the plain read
// returns only this user's rows.
function ListingAlertsSection({ itemId }: { itemId: string }) {
  // US-2519: the shared page read. The `platform_fields ? 'key'` filter was
  // never expressible through the supabase-js builder anyway, so this always
  // filtered in the client — it just used to pay for its own round trip first.
  const { data: rows = [] } = useItemListings(itemId);
  const flagged = flaggedListings(rows);

  if (flagged.length === 0) return null;

  return (
    <div className="space-y-3">
      {flagged.map((row) => (
        <ListingAlertMarkers
          key={row.id}
          platformFields={row.platform_fields}
          platform={row.platform}
          listingUrl={row.listing_url}
        />
      ))}
    </div>
  );
}

// US-2170: the Listing Quality Score with its per-component breakdown.
//
// The listings table shows the NUMBER (read cheaply from the persisted
// quality_score column, page-scoped). This card shows the BREAKDOWN, which only
// the /listings/validate response carries — the components, their weights, and
// the ranked fixes. A score with no breakdown is a grade with no feedback.
//
// Renders nothing when there is no score. An item with no eBay category yet
// genuinely has no score, and an empty card would be noise on every fresh item.
function ListingQualityCard({ itemId }: { itemId: string }) {
  const { data: quality } = useListingQuality(itemId);
  if (!quality) return null;

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Listing quality</span>
          <QualityScoreChip score={quality} />
          {quality.weightCounted < 100 && (
            // Say so when the score covers only part of the rubric — otherwise a
            // partial score reads as a full one, and a seller optimises against
            // a number that was never measuring everything.
            <span className="text-xs text-muted-foreground">
              scored on {quality.weightCounted}% of the checks
            </span>
          )}
        </div>
        <QualityScoreBreakdown score={quality} />
      </CardContent>
    </Card>
  );
}

// US-1081: for listings GradeThread published to eBay, GradeThread is the source
// of truth. Show an "Edit in GradeThread" badge (warn that eBay-side edits get
// overwritten) and, when an inbound sync detected eBay-owned values drifting on
// eBay, a non-blocking "eBay differs" indicator with a "Re-push to eBay" action
// that re-asserts GradeThread's values. The indicator is informational only — it
// never pulls eBay's drifted value back into GradeThread.
function GradethreadListingCard({
  itemId,
  itemTitle,
}: {
  itemId: string;
  itemTitle: string | null;
}) {
  const queryClient = useQueryClient();
  const { data: ebayConnection } = useEbayConnection();
  const revise = useEbayReviseListing();

  // US-2519: the shared page read, filtered here instead of in SQL. The key is
  // the shared one, so a revise invalidates every panel at once rather than
  // leaving three of them showing the pre-revise row.
  const queryKey = itemListingsKey(itemId);
  const { data: rows = [] } = useItemListings(itemId);
  const listing = ebayListing(rows);

  if (!ebayConnection || !listing) return null;

  const origin = deriveListingOrigin({
    platform: "ebay",
    platform_listing_id: listing.platform_listing_id,
    batch_id: listing.batch_id,
    synced_to_ebay_at: listing.synced_to_ebay_at,
  });

  // Only for GradeThread-originated listings that are actually live on eBay
  // (an offer id means we can re-push via the Sell API). Drafts / eBay-native
  // listings are handled elsewhere.
  if (origin !== "gradethread" || !listing.platform_offer_id) return null;

  const drift = (listing.platform_fields?.sync_drift ?? null) as
    | SyncDriftMarker
    | null;
  const driftedFields = drift?.fields?.filter(Boolean) ?? [];
  // US-1079: a prior outbound push that eBay rejected is recorded on the listing
  // (publish_error/publish_failed_at). Surface it with a retry that re-asserts.
  const pushError = listing.publish_error?.trim() || null;

  async function rePush() {
    const lst = listing!;
    try {
      await revise.mutateAsync({
        listingId: lst.id,
        patch: {
          title: (lst.listing_title ?? itemTitle ?? undefined) || undefined,
          description: lst.listing_description ?? undefined,
          listing_price: lst.listing_price ?? undefined,
          // US-1079: re-assert quantity too — full eBay-owned field coverage.
          quantity: lst.quantity ?? undefined,
          // Force the full re-PUT so photos/specifics re-assert too even when
          // no text field changed.
          photos: true,
          // `photos: true` alone re-PUTs the inventory item but never touches
          // the OFFER, and the eBay leaf category lives on the offer — so this
          // button used to be structurally incapable of fixing the one failure
          // it is most often clicked for. A listing re-categorised in
          // GradeThread (Dresses → Tops) kept getting its new specifics judged
          // against the OLD category on eBay, which rejected them for a
          // specific the new category doesn't even have ("Dress Length is
          // missing"). Every retry then failed identically, so the banner read
          // as permanent. resync_ebay_fields is what carries the category (and
          // condition, and specifics) and runs the category-swap bridge.
          resync_ebay_fields: true,
        },
      });
      toast.success("Re-pushed your GradeThread values to eBay.");
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["items_full"] });
    } catch (e) {
      toastError(e, "Couldn't re-push to eBay.");
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-2 font-medium">
          <BadgeCheck className="h-4 w-4 text-brand-red-text" />
          Edit in GradeThread
          <Badge variant="outline" className="font-normal">
            Source of truth
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          You published this listing from GradeThread, so manage it here. Edits
          made directly on eBay aren't authoritative and will be overwritten the
          next time you push from GradeThread.
        </p>

        {driftedFields.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
            <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
              eBay differs
            </div>
            <p className="mt-1 text-amber-700 dark:text-amber-200/80">
              The {driftedFields.map(driftFieldLabel).join(", ")}{" "}
              {driftedFields.length === 1 ? "field was" : "fields were"} changed
              on eBay since your last push. GradeThread kept your values — re-push
              to re-assert them on eBay.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={rePush}
              disabled={revise.isPending}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {revise.isPending ? "Re-pushing…" : "Re-push to eBay"}
            </Button>
          </div>
        )}

        {pushError && (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm dark:border-red-900/50 dark:bg-red-950/30">
            <div className="flex items-center gap-2 font-medium text-red-800 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" />
              Last push to eBay failed
            </div>
            <p className="mt-1 text-red-700 dark:text-red-200/80">{pushError}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={rePush}
              disabled={revise.isPending}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {revise.isPending ? "Retrying…" : "Retry push"}
            </Button>
          </div>
        )}

        {safeHref(listing.listing_url) && (
          <Button asChild variant="ghost" size="sm" className="px-0">
            <a
              href={safeHref(listing.listing_url) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              View on eBay
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// US-1047: leave positive buyer feedback on a sold eBay order. The edge resolves
// the legacy ItemID/TransactionID from the order id, so we only need the sale's
// platform_order_id (an eBay order). Shown only once the item has such a sale.
function LeaveFeedbackCard({ itemId }: { itemId: string }) {
  const { data: ebayConnection } = useEbayConnection();
  const leave = useEbayLeaveFeedback();

  const { data: orderId } = useQuery({
    queryKey: ["item_ebay_order", itemId],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from("sales")
        .select("platform_order_id")
        .eq("inventory_item_id", itemId)
        .not("platform_order_id", "is", null)
        .order("sale_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as { platform_order_id: string | null } | null)
        ?.platform_order_id ?? null;
    },
  });

  if (!ebayConnection || !orderId) return null;

  async function send() {
    try {
      const res = await leave.mutateAsync({ orderId: orderId! });
      toast.success(
        res.already_left
          ? "Feedback was already left for this order."
          : `Positive feedback left${res.count > 1 ? ` (${res.count} items)` : ""}.`,
      );
    } catch (e) {
      toastError(e, "Couldn't leave feedback.");
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 font-medium">
            <Store className="h-4 w-4 text-brand-red-text" />
            Buyer feedback
          </div>
          <p className="text-sm text-muted-foreground">
            Leave positive feedback for the buyer on this sold order.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={send}
          disabled={leave.isPending}
          className="shrink-0"
        >
          {leave.isPending ? "Leaving…" : "Leave positive feedback"}
        </Button>
      </CardContent>
    </Card>
  );
}

// US-1044/1045: per-listing Promoted Listings (opt in/out + ad rate) and eBay
// Sale (markdown) controls. Reads the item's active eBay listing; the Sale's
// active state is tracked in listings.platform_fields.markdown_promotion_id.
function PromotionSaleCard({ itemId }: { itemId: string }) {
  const queryClient = useQueryClient();
  const { data: ebayConnection } = useEbayConnection();

  // US-2519: the shared page read. A listing with no platform_listing_id is not
  // truly live on eBay, so there is nothing to promote or discount.
  const { data: rows = [] } = useItemListings(itemId);
  const active = activeListing(rows);
  const listing = active?.platform_listing_id
    ? {
        id: active.id,
        markdownActive:
          typeof active.platform_fields?.markdown_promotion_id === "string",
      }
    : null;

  const listingId = listing?.id ?? null;
  const { data: promo } = useEbayPromotion(listingId, !!ebayConnection);
  const setPromo = useEbaySetPromotion();
  const removePromo = useEbayRemovePromotion();
  const startSale = useEbayStartSale();
  const endSale = useEbayEndSale();

  const [rate, setRate] = useState<string>("");
  const [salePct, setSalePct] = useState<string>("15");

  if (!ebayConnection || !listingId) return null;

  const promoted = !!promo && !promo.opt_out && !!promo.ad_id;
  const rateValue = rate !== ""
    ? Number(rate)
    : (promo?.rate_pct ?? promo?.suggested_rate_pct ?? 8);

  async function applyPromo() {
    try {
      const res = await setPromo.mutateAsync({ listingId: listingId!, ratePct: rateValue });
      toast.success(`Promoting at ${res.rate_pct}% ad rate.`);
      setRate("");
      queryClient.invalidateQueries({ queryKey: ["ebay_promotion", listingId] });
    } catch (e) {
      toastError(e, "Couldn't update promotion.");
    }
  }
  async function stopPromo() {
    try {
      await removePromo.mutateAsync({ listingId: listingId! });
      toast.success("Stopped promoting this listing.");
      queryClient.invalidateQueries({ queryKey: ["ebay_promotion", listingId] });
    } catch (e) {
      toastError(e, "Couldn't stop promotion.");
    }
  }
  async function beginSale() {
    const pct = Number(salePct);
    if (!Number.isFinite(pct) || pct <= 0) {
      toast.error("Enter a valid Sale percentage.");
      return;
    }
    try {
      await startSale.mutateAsync({ listingId: listingId!, percentOff: pct });
      toast.success(`Sale started — ${pct}% off with a SALE badge.`);
      queryClient.invalidateQueries({ queryKey: itemListingsKey(itemId) });
    } catch (e) {
      toastError(e, "Couldn't start the Sale.");
    }
  }
  async function stopSale() {
    try {
      await endSale.mutateAsync({ listingId: listingId! });
      toast.success("Sale ended — original price restored.");
      queryClient.invalidateQueries({ queryKey: itemListingsKey(itemId) });
    } catch (e) {
      toastError(e, "Couldn't end the Sale.");
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {/* Promoted Listings */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 font-medium">
            <Megaphone className="h-4 w-4 text-brand-red-text" />
            Promoted Listing
            {promoted && (
              <Badge variant="outline" className="font-normal">
                Active · {promo?.rate_pct ?? rateValue}%
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            A Cost-Per-Sale ad boosts visibility; eBay charges the ad rate only
            when the item sells through the ad.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={2}
                max={20}
                step={0.5}
                aria-label="Promoted listing ad rate percent"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder={String(promo?.rate_pct ?? promo?.suggested_rate_pct ?? 8)}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">% rate</span>
            </div>
            <Button size="sm" onClick={applyPromo} disabled={setPromo.isPending}>
              {promoted ? "Update rate" : "Promote"}
            </Button>
            {promoted && (
              <Button
                size="sm"
                variant="outline"
                onClick={stopPromo}
                disabled={removePromo.isPending}
              >
                Stop promoting
              </Button>
            )}
          </div>
        </div>

        <div className="border-t" />

        {/* Markdown Sale */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 font-medium">
            <Percent className="h-4 w-4 text-brand-red-text" />
            eBay Sale
            {listing?.markdownActive && (
              <Badge variant="outline" className="font-normal">
                Running
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Runs a markdown promotion — buyers see a strike-through price and SALE
            badge, and watchers get notified. Ending it restores the price.
          </p>
          {listing?.markdownActive ? (
            <Button
              size="sm"
              variant="outline"
              onClick={stopSale}
              disabled={endSale.isPending}
            >
              End Sale
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={5}
                  max={70}
                  step={5}
                  aria-label="Sale discount percent"
                  value={salePct}
                  onChange={(e) => setSalePct(e.target.value)}
                  className="w-24"
                />
                <span className="text-sm text-muted-foreground">% off</span>
              </div>
              <Button size="sm" onClick={beginSale} disabled={startSale.isPending}>
                Start Sale
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// items_full doesn't expose the flag, so read/write inventory_items directly
// (RLS scopes both to the caller's own rows).
function AutomationOptOutCard({ itemId }: { itemId: string }) {
  const queryClient = useQueryClient();

  const { data: excluded, isLoading } = useQuery({
    queryKey: ["item_automation_optout", itemId],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("exclude_from_automations")
        .eq("id", itemId)
        .single();
      if (error) throw error;
      return (data as { exclude_from_automations: boolean })
        .exclude_from_automations;
    },
  });

  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      const { error } = await supabase
        .from("inventory_items")
        .update({ exclude_from_automations: next } as never)
        .eq("id", itemId);
      if (error) throw error;
      return next;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["item_automation_optout", itemId], next);
      toast.success(
        next
          ? "Excluded from automations — rules will skip this item."
          : "Automations re-enabled for this item.",
      );
    },
    onError: () => toast.error("Couldn't update the automation setting."),
  });

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 pt-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <Zap className="h-4 w-4 text-brand-red-text" />
            Exclude from automations
          </div>
          <p className="text-sm text-muted-foreground">
            Price-drop, promo, and end-listing rules from the Automations page
            will skip this item.
          </p>
        </div>
        <Switch
          checked={excluded ?? false}
          onCheckedChange={(next) => toggle.mutate(next)}
          disabled={isLoading || toggle.isPending}
          aria-label="Exclude from automations"
        />
      </CardContent>
    </Card>
  );
}
