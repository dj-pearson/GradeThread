import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useLocation, Link } from "react-router-dom";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { supabase } from "@/lib/supabase";
import { useItemsFull } from "@/hooks/use-items-full";
import {
  useEbayConnection,
  useEbayEndSale,
  useEbayLeaveFeedback,
  useEbayPromotion,
  useEbayRemovePromotion,
  useEbayReviseListing,
  useEbaySetPromotion,
  useEbayStartSale,
} from "@/hooks/use-ebay";
import {
  deriveListingOrigin,
  driftFieldLabel,
  type SyncDriftMarker,
} from "@/lib/listing-origin";
import { ItemCanvas } from "@/components/flipdesk/item-canvas";
import { ConditionIndexValueHint } from "@/components/flipdesk/condition-index-value-hint";
import { GradeRoiHint } from "@/components/flipdesk/grade-roi-hint";
import { GradeOutcomeCard } from "@/components/flipdesk/grade-outcome-card";
import { DisclosurePanel } from "@/components/disclosure/disclosure-panel";
import { ITEM_STATUS_LABELS } from "@/lib/constants";

// Deep-linkable item detail page. The canvas itself is shared with the
// quick-look dialog opened from list rows.
export function FlipdeskItemPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hash } = useLocation();

  // Shared items_full read — single source of truth across FlipDesk (US-419).
  const { data: items = [], isLoading } = useItemsFull();

  const item = useMemo(
    () => items.find((it) => it.id === id) ?? null,
    [items, id],
  );

  // Deep links like /items/:id#canvas-grading (US-859 stale-listing "grade it"
  // nudge) should land on the grade section once the item has rendered.
  useEffect(() => {
    if (!hash || !item) return;
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash, item]);

  function goBack() {
    navigate("/dashboard/flipdesk/items");
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
    <div className="mx-auto max-w-4xl space-y-6">
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
          <Link to="/dashboard/flipdesk/items" className="hover:text-foreground">
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

      {/* US-856: proactive grade-ROI nudge from the seller's own sold history.
          CTA scrolls to the canvas grade section. Suppresses itself once the
          item is graded or when the category sample is too thin. */}
      <GradeRoiHint
        category={item.category}
        grade={item.grade_value}
        priceHint={item.target_price ?? item.list_price ?? item.purchase_price}
        onGrade={() => {
          const el = document.getElementById("canvas-grading");
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />

      {/* US-857: once a graded item sells, close the loop — show its grade →
          realized outcome, plus an account-level graded-vs-ungraded rollup
          (gated on the share_sale_outcomes opt-in + low-n suppression). */}
      <GradeOutcomeCard item={item} />

      {/* eBay-NATIVE listings can't be revised through GradeThread — this notes
          that + links to eBay. GradeThread-published listings are edited and
          pushed inline by the canvas "Save & sync to eBay" button below. */}
      <EbayNativeNotice itemId={item.id} />

      {/* US-1081: GradeThread-originated live listings — authority badge +
          non-blocking eBay-drift indicator with a "Re-push to eBay" re-assert. */}
      <GradethreadListingCard itemId={item.id} itemTitle={item.item_title} />

      <PromotionSaleCard itemId={item.id} />

      <LeaveFeedbackCard itemId={item.id} />

      {/* On the page, Save keeps the user here (the query refetches); only
          Cancel and the back button navigate away. */}
      <ItemCanvas item={item} onCancel={goBack} />

      {/* US-848: grade-anchored value from the public Condition Index curve. */}
      <ConditionIndexValueHint
        brand={item.brand}
        category={item.category}
        title={item.item_title}
        grade={item.grade_value}
      />

      {/* Auto-Disclosure Engine: condition & flaws + annotated defect photos. */}
      <DisclosurePanel itemId={item.id} />

      {/* US-150: per-listing opt-out from the price-drop/promo scheduler. */}
      <AutomationOptOutCard itemId={item.id} />
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

  const { data: listing } = useQuery({
    queryKey: ["item_ebay_native_notice", itemId],
    queryFn: async (): Promise<{
      platform_offer_id: string | null;
      listing_url: string | null;
    } | null> => {
      const { data, error } = await supabase
        .from("listings")
        .select("platform_offer_id, listing_url")
        .eq("inventory_item_id", itemId)
        .eq("listing_status", "active")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as {
        platform_offer_id: string | null;
        listing_url: string | null;
      } | null;
    },
  });

  // Only for an active eBay-native listing (no Sell offer). GradeThread-published
  // listings and drafts render nothing — the canvas handles those.
  if (!ebayConnection || !listing || listing.platform_offer_id) return null;

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-center gap-2 font-medium">
          <Store className="h-4 w-4 text-brand-red-text" />
          Listed on eBay (created on eBay)
        </div>
        <p className="text-sm text-muted-foreground">
          This listing was created on eBay, not GradeThread, so its eBay fields
          (title, price, description, photos) are managed on eBay. Saving here
          updates only your internal FlipDesk fields. To change what buyers see,
          edit it on eBay — or relist it through GradeThread to manage it here.
        </p>
        {listing.listing_url && (
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <a
              href={listing.listing_url}
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

  type GtListingRow = {
    id: string;
    platform_offer_id: string | null;
    platform_listing_id: string | null;
    listing_url: string | null;
    listing_status: string | null;
    listing_title: string | null;
    listing_description: string | null;
    listing_price: number | null;
    batch_id: string | null;
    synced_to_ebay_at: string | null;
    platform_fields: Record<string, unknown> | null;
  };

  const queryKey = ["item_gt_listing", itemId];
  const { data: listing } = useQuery({
    queryKey,
    queryFn: async (): Promise<GtListingRow | null> => {
      const { data, error } = await supabase
        .from("listings")
        .select(
          "id, platform_offer_id, platform_listing_id, listing_url, listing_status, listing_title, listing_description, listing_price, batch_id, synced_to_ebay_at, platform_fields",
        )
        .eq("inventory_item_id", itemId)
        .eq("platform", "ebay")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as GtListingRow | null;
    },
  });

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

  async function rePush() {
    const lst = listing!;
    try {
      await revise.mutateAsync({
        listingId: lst.id,
        patch: {
          title: (lst.listing_title ?? itemTitle ?? undefined) || undefined,
          description: lst.listing_description ?? undefined,
          listing_price: lst.listing_price ?? undefined,
          // Force the full re-PUT so photos/specifics re-assert too even when
          // no text field changed.
          photos: true,
        },
      });
      toast.success("Re-pushed your GradeThread values to eBay.");
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["items_full"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't re-push to eBay.");
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

        {listing.listing_url && (
          <Button asChild variant="ghost" size="sm" className="px-0">
            <a
              href={listing.listing_url}
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
      toast.error(e instanceof Error ? e.message : "Couldn't leave feedback.");
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

  const { data: listing } = useQuery({
    queryKey: ["item_ebay_listing", itemId],
    queryFn: async (): Promise<
      { id: string; markdownActive: boolean } | null
    > => {
      const { data, error } = await supabase
        .from("listings")
        .select("id, platform_listing_id, platform_fields")
        .eq("inventory_item_id", itemId)
        .eq("listing_status", "active")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const row = data as unknown as {
        id: string;
        platform_listing_id: string | null;
        platform_fields: { markdown_promotion_id?: unknown } | null;
      };
      if (!row.platform_listing_id) return null; // not truly live on eBay
      return {
        id: row.id,
        markdownActive: typeof row.platform_fields?.markdown_promotion_id ===
          "string",
      };
    },
  });

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
      toast.error(e instanceof Error ? e.message : "Couldn't update promotion.");
    }
  }
  async function stopPromo() {
    try {
      await removePromo.mutateAsync({ listingId: listingId! });
      toast.success("Stopped promoting this listing.");
      queryClient.invalidateQueries({ queryKey: ["ebay_promotion", listingId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't stop promotion.");
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
      queryClient.invalidateQueries({ queryKey: ["item_ebay_listing", itemId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start the Sale.");
    }
  }
  async function stopSale() {
    try {
      await endSale.mutateAsync({ listingId: listingId! });
      toast.success("Sale ended — original price restored.");
      queryClient.invalidateQueries({ queryKey: ["item_ebay_listing", itemId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't end the Sale.");
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
