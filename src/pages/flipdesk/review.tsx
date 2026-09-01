import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  Clock,
  ExternalLink,
  Loader2,
  Puzzle,
  Sparkles,
  Zap,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { toastError } from "@/lib/toast-error";
import { track } from "@/lib/analytics";
import {
  ITEM_CATEGORY_LABELS,
  MARKETPLACE_LABELS,
  REQUIRED_PHOTO_TYPES,
} from "@/lib/constants";
import { formatMeasurementValue, measurementLabel } from "@/lib/measurements";
import {
  approveSummary,
  planApprove,
  reviewChannels,
  secondsFromFirstPhoto,
  type ReviewChannel,
} from "@/lib/review-flow";
import { reviewHardBlockers, type ReviewBlocker } from "@/pages/flipdesk/draft-quality";
import { useCrossPostChannels } from "@/hooks/use-cross-post-channels";
import { useCrossPush } from "@/hooks/use-cross-listing";
import { useEbayConnection, useGradeBandedPrice, usePublishToEbay } from "@/hooks/use-ebay";
import { useShopifyConnection } from "@/hooks/use-shopify";
import { useListingCopy } from "@/hooks/use-ai-extract";
import { QUEUED_NOTICE, useEnqueueExtensionWork } from "@/hooks/use-extension-queue";
import { recordReviewApprove, reviewMedianKey, useSetReviewFlow } from "@/hooks/use-review-flow";

// US-9204: one review card, one Approve.
//
// Photos came in on the intake page (or, once ported, from a phone). Every
// piece on this card already exists on a FlipDesk stage page: the grade panel,
// the measure card, the specifics picker, the composer, the pricing page, the
// listing kit. This page is the spine that shows them together and runs them
// in one pass. No stage page goes away; every block links to its own.
//
// The one sentence that must stay true: a queued channel is not a listed one.
// Approve publishes the API channels and QUEUES the extension channels, and the
// card says which is which in the words the desktop queue already uses.

interface ReviewItemRow {
  id: string;
  title: string;
  brand: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  description: string | null;
  condition_summary: string | null;
  item_category: string | null;
  garment_category: string | null;
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  attributes: Record<string, string | string[]> | null;
  target_price: number | string | null;
  grade_value: number | null;
  grade_label: string | null;
  certificate_url: string | null;
  submission_id: string | null;
  measurements: Record<string, number | string> | null;
  status: string;
}

interface ReviewPhotoRow {
  id: string;
  photo_url: string;
  photo_type: string | null;
  sort_order: number;
  created_at: string;
}

interface ReviewListingRow {
  id: string;
  platform: string;
  listing_status: string | null;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | string | null;
  listing_url: string | null;
  created_at: string;
}

function numberOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function useReviewItem(itemId: string | undefined) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["review_item", user?.id, itemId],
    enabled: !!user && !!itemId,
    queryFn: async () => {
      const [item, photos, listings] = await Promise.all([
        supabase
          .from("inventory_items")
          .select(
            "id, title, brand, size, color, material, description, condition_summary, " +
              "item_category, garment_category, ebay_category_id, ebay_aspects, attributes, " +
              "target_price, grade_value, grade_label, certificate_url, submission_id, " +
              "measurements, status",
          )
          .eq("id", itemId as string)
          .maybeSingle(),
        supabase
          .from("item_photos")
          .select("id, photo_url, photo_type, sort_order, created_at")
          .eq("inventory_item_id", itemId as string)
          .order("sort_order", { ascending: true }),
        supabase
          .from("listings")
          .select(
            "id, platform, listing_status, listing_title, listing_description, listing_price, listing_url, created_at",
          )
          .eq("inventory_item_id", itemId as string)
          .order("created_at", { ascending: false }),
      ]);
      if (item.error) throw item.error;
      return {
        item: (item.data ?? null) as ReviewItemRow | null,
        photos: ((photos.data ?? []) as ReviewPhotoRow[]),
        listings: ((listings.data ?? []) as ReviewListingRow[]),
      };
    },
  });
}

interface ChannelOutcome {
  platform: string;
  label: string;
  state: "live" | "queued" | "failed";
  detail?: string;
  url?: string | null;
}

export function FlipdeskReviewPage() {
  const { id: itemId } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const { data, isLoading, isError, refetch } = useReviewItem(itemId);
  const item = data?.item ?? null;
  const photos = useMemo(() => data?.photos ?? [], [data]);
  const listings = useMemo(() => data?.listings ?? [], [data]);

  const { data: chosenChannels } = useCrossPostChannels();
  const { data: ebayConn } = useEbayConnection();
  const { data: shopifyConn } = useShopifyConnection();
  const publishEbay = usePublishToEbay();
  const crossPush = useCrossPush();
  const enqueue = useEnqueueExtensionWork();
  const listingCopy = useListingCopy();
  const setReviewFlow = useSetReviewFlow();

  // The editable trio. Seeded once per item from the item, or from its newest
  // eBay draft when the composer already wrote one.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const ebayDraft = useMemo(
    () => listings.find((l) => l.platform === "ebay") ?? null,
    [listings],
  );
  useEffect(() => {
    if (!item || seededFor === item.id) return;
    setTitle(ebayDraft?.listing_title ?? item.title ?? "");
    setDescription(ebayDraft?.listing_description ?? item.description ?? "");
    const p = [ebayDraft?.listing_price, item.target_price]
      .map((v) => numberOr(v, 0))
      .find((v) => v > 0);
    setPrice(p ? String(p) : "");
    setSeededFor(item.id);
  }, [item, ebayDraft, seededFor]);

  // Channels: what the seller cross-posts to, split by how it is reached.
  const channels = useMemo(() => reviewChannels(chosenChannels), [chosenChannels]);
  const connected = (c: ReviewChannel) =>
    c.mode !== "now" ||
    (c.platform === "ebay" ? ebayConn?.is_active === true : c.platform === "shopify" ? shopifyConn?.is_active === true : false);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const effectiveSelected = useMemo(() => {
    if (selected) return selected;
    // Default: everything that can run, which is every connected API channel
    // and every extension channel. A channel that is not live yet is never
    // ticked for the seller.
    return new Set(channels.filter((c) => c.mode !== "later" && connected(c)).map((c) => c.platform));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, channels, ebayConn?.is_active, shopifyConn?.is_active]);
  const plan = useMemo(() => planApprove(effectiveSelected), [effectiveSelected]);

  // Price suggestion from realized sales, when there is enough to ask with.
  const priceNum = numberOr(price, 0);
  const suggestion = useGradeBandedPrice({
    categoryId: item?.ebay_category_id ?? null,
    q: item?.title,
    brand: item?.brand ?? undefined,
    size: item?.size ?? undefined,
    grade: item?.grade_value ?? null,
  });
  const suggestedPrice =
    suggestion.data?.recommendedCents != null
      ? Math.round(suggestion.data.recommendedCents) / 100
      : null;

  const category = item?.ebay_category_id ?? item?.item_category ?? item?.garment_category ?? null;
  const blockers: ReviewBlocker[] = item
    ? reviewHardBlockers({
        photoTypes: photos.map((p) => p.photo_type),
        requiredPhotoTypes: REQUIRED_PHOTO_TYPES,
        price: priceNum,
        category,
      })
    : [];

  // First photo: the intake passes it in the URL; a reload or a phone-created
  // item falls back to the oldest photo's upload time.
  const firstPhotoMs = useMemo(() => {
    const fromParam = Number(params.get("from"));
    if (Number.isFinite(fromParam) && fromParam > 0) return fromParam;
    const oldest = photos
      .map((p) => Date.parse(p.created_at))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b)[0];
    return oldest ?? null;
  }, [params, photos]);

  const [approving, setApproving] = useState(false);
  const [outcome, setOutcome] = useState<ChannelOutcome[] | null>(null);

  const itemPath = item ? `/dashboard/flipdesk/items/${item.id}` : "/dashboard/flipdesk/items";

  async function writeCopy() {
    if (!item) return;
    try {
      const res = await listingCopy.mutateAsync({ item_id: item.id });
      if (res.title && !title.trim()) setTitle(res.title);
      else if (res.title && title === item.title) setTitle(res.title);
      if (res.description) setDescription(res.description);
    } catch {
      /* the hook toasts */
    }
  }

  async function approve() {
    if (!item || !user) return;
    if (blockers.length > 0) {
      // Our own sentence from draft-quality.ts, not a server's.
      const why = blockerSentence(blockers);
      toast.error(why);
      return;
    }
    if (!title.trim()) {
      toast.error("Give it a title.");
      return;
    }
    if (plan.now.length === 0 && plan.queued.length === 0) {
      toast.error("Pick at least one channel.");
      return;
    }
    setApproving(true);
    const results: ChannelOutcome[] = [];
    try {
      // 1. The item carries the reviewed price and description, so every stage
      //    page shows what was approved.
      const { error: itemErr } = await supabase
        .from("inventory_items")
        .update({ target_price: priceNum, description: description || null } as never)
        .eq("id", item.id);
      if (itemErr) throw itemErr;

      // 2. The eBay draft row is the cross-listing anchor (cross-push fans out
      //    from it, the eBay push reads it). Update the newest one when it is
      //    still a draft, create one when there is none, leave a live one alone.
      let draftId = ebayDraft?.id ?? null;
      const draftLive = ebayDraft?.listing_status === "active";
      if (ebayDraft && !draftLive) {
        const { error } = await supabase
          .from("listings")
          .update({
            listing_title: title.trim(),
            listing_description: description,
            listing_price: priceNum,
            reviewed_at: new Date().toISOString(),
          } as never)
          .eq("id", ebayDraft.id);
        if (error) throw error;
      } else if (!ebayDraft) {
        const { data: created, error } = await supabase
          .from("listings")
          .insert({
            inventory_item_id: item.id,
            platform: "ebay",
            listing_status: "draft",
            is_active: false,
            listing_title: title.trim(),
            listing_description: description,
            listing_price: priceNum,
            listing_origin: "gradethread",
            reviewed_at: new Date().toISOString(),
          } as never)
          .select("id")
          .single();
        if (error) throw error;
        draftId = (created as { id: string }).id;
      }

      // 3. API channels run now. eBay through its own push (it validates the
      //    whole listing and reports blockers); the rest through cross-push
      //    from the draft.
      const labelOf = (p: string) => MARKETPLACE_LABELS[p as keyof typeof MARKETPLACE_LABELS] ?? p;
      if (plan.now.includes("ebay")) {
        if (draftLive) {
          results.push({ platform: "ebay", label: "eBay", state: "live", url: ebayDraft?.listing_url ?? null, detail: "Already live." });
        } else {
          try {
            const res = await publishEbay.mutateAsync({ itemId: item.id });
            results.push({ platform: "ebay", label: "eBay", state: "live", url: res.listing_url ?? null });
          } catch (err) {
            results.push({ platform: "ebay", label: "eBay", state: "failed", detail: (err as Error).message });
          }
        }
      }
      const others = plan.now.filter((p) => p !== "ebay");
      if (others.length > 0 && draftId) {
        try {
          const res = await crossPush.mutateAsync({ listingId: draftId, platforms: others });
          for (const p of others) {
            const r = res.results[p];
            results.push(
              r?.ok
                ? { platform: p, label: labelOf(p), state: "live", url: r.listing_url ?? null }
                : { platform: p, label: labelOf(p), state: "failed", detail: r?.error ?? ((r?.blockers ?? []).join(" ") || "Could not publish.") },
            );
          }
        } catch (err) {
          for (const p of others) {
            results.push({ platform: p, label: labelOf(p), state: "failed", detail: (err as Error).message });
          }
        }
      }

      // 4. Extension channels are queued for the desktop browser. Never "listed".
      for (const p of plan.queued) {
        try {
          await enqueue.mutateAsync({ kind: "list", platform: p, inventoryItemId: item.id, payload: {} });
          results.push({ platform: p, label: labelOf(p), state: "queued" });
        } catch (err) {
          results.push({ platform: p, label: labelOf(p), state: "failed", detail: (err as Error).message });
        }
      }

      // 5. The number this story exists for.
      const seconds = secondsFromFirstPhoto(firstPhotoMs, Date.now());
      await recordReviewApprove(item.id, seconds);
      track("review_approved", {
        seconds_from_first_photo: seconds,
        channels_now: results.filter((r) => r.state === "live").length,
        channels_queued: results.filter((r) => r.state === "queued").length,
        source: "web",
      });

      setOutcome(results);
      void qc.invalidateQueries({ queryKey: ["items_full"] });
      void qc.invalidateQueries({ queryKey: ["review_item"] });
      void qc.invalidateQueries({ queryKey: reviewMedianKey(user.id) });
      const live = results.filter((r) => r.state === "live").length;
      const queued = results.filter((r) => r.state === "queued").length;
      const failed = results.filter((r) => r.state === "failed").length;
      if (failed === 0) {
        toast.success(
          [
            live > 0 ? `Live on ${live} channel${live === 1 ? "" : "s"}.` : "",
            queued > 0 ? `${queued} queued for your desktop browser.` : "",
          ].filter(Boolean).join(" "),
        );
      } else {
        toast.warning(`${failed} channel${failed === 1 ? "" : "s"} did not go through. See the list below.`);
      }
    } catch (err) {
      toastError(err, "Couldn't approve this item.");
    } finally {
      setApproving(false);
    }
  }

  if (!itemId) return <ErrorState title="No item to review." description="Open an item from Inventory and press Review." />;
  if (isError) return <ErrorState title="Couldn't load this item." onRetry={() => void refetch()} />;
  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!item) return <ErrorState title="That item is not here any more." description="It may have been deleted, or it belongs to another workspace." hideSupport />;

  const gradePending = item.grade_value == null && !!item.submission_id;
  const measurementEntries = Object.entries(item.measurements ?? {})
    .map(([k, v]) => [k, formatMeasurementValue(k, v)] as const)
    .filter((e): e is readonly [string, string] => !!e[1]);
  const specifics: [string, string][] = item.ebay_aspects && Object.keys(item.ebay_aspects).length > 0
    ? Object.entries(item.ebay_aspects).map(([k, v]) => [k, v.join(", ")])
    : Object.entries(item.attributes ?? {}).map(([k, v]) => [k.replace(/_/g, " "), Array.isArray(v) ? v.join(", ") : v]);
  for (const [k, v] of [["Brand", item.brand], ["Size", item.size], ["Color", item.color], ["Material", item.material]] as const) {
    if (v && !specifics.some(([sk]) => sk.toLowerCase() === k.toLowerCase())) specifics.unshift([k, v]);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Review and list"
        subtitle="Check the card, press Approve. Every block opens its own page if something needs a closer look."
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link to={itemPath}>Open the item page</Link>
          </Button>
        }
      />

      {outcome ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="h-4 w-4" /> Approved
            </CardTitle>
            <CardDescription>What happened on each channel.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2 text-sm">
              {outcome.map((o) => (
                <li key={o.platform} className="flex flex-wrap items-start gap-2">
                  <Badge variant={o.state === "failed" ? "destructive" : o.state === "queued" ? "secondary" : "default"}>
                    {o.state === "live" ? "Live" : o.state === "queued" ? "Queued" : "Not listed"}
                  </Badge>
                  <span className="font-medium">{o.label}</span>
                  {o.url ? (
                    <a href={o.url} target="_blank" rel="noopener noreferrer" aria-label={`View the ${o.label} listing`} className="inline-flex items-center gap-1 underline underline-offset-2">
                      View <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                  {o.detail ? <span className="text-muted-foreground">{o.detail}</span> : null}
                </li>
              ))}
            </ul>
            {outcome.some((o) => o.state === "queued") ? (
              <p className="text-xs text-muted-foreground">{QUEUED_NOTICE}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to="/dashboard/flipdesk/intake">Add the next item</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to={itemPath}>Open the item page</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Photos */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Photos</CardTitle>
            <CardDescription>
              {photos.length === 0 ? "No photos yet." : `${photos.length} photo${photos.length === 1 ? "" : "s"}.`}
            </CardDescription>
          </div>
          <EditLink to={itemPath} />
        </CardHeader>
        {photos.length > 0 ? (
          <CardContent>
            <div className="flex gap-2 overflow-x-auto">
              {photos.slice(0, 8).map((p) => (
                <img
                  key={p.id}
                  src={p.photo_url}
                  alt={p.photo_type ?? "photo"}
                  className="h-20 w-20 shrink-0 rounded-md object-cover"
                  loading="lazy"
                />
              ))}
            </div>
          </CardContent>
        ) : null}
      </Card>

      {/* Grade */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Grade</CardTitle>
            <CardDescription>
              {item.grade_value != null
                ? `${item.grade_value.toFixed(1)}${item.grade_label ? ` (${item.grade_label})` : ""}`
                : gradePending
                  ? "Grading, usually under a minute."
                  : "Not graded. A grade lifts trust and price."}
            </CardDescription>
          </div>
          <EditLink to={`${itemPath}#canvas-grading`} label={item.grade_value != null ? "Edit details" : "Grade it"} />
        </CardHeader>
        {gradePending ? (
          <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> You can approve now. The grade attaches when it lands.
          </CardContent>
        ) : null}
      </Card>

      {/* Measurements */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Measurements</CardTitle>
            <CardDescription>
              {measurementEntries.length === 0 ? "None recorded. Buyers ask; it is worth a minute." : `${measurementEntries.length} recorded.`}
            </CardDescription>
          </div>
          <EditLink to={itemPath} />
        </CardHeader>
        {measurementEntries.length > 0 ? (
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              {measurementEntries.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{measurementLabel(k)}</dt>
                  <dd className="tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        ) : null}
      </Card>

      {/* Specifics */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Item specifics</CardTitle>
            <CardDescription>
              {category
                ? `Category: ${ITEM_CATEGORY_LABELS[category as keyof typeof ITEM_CATEGORY_LABELS] ?? category}`
                : "No category yet."}
            </CardDescription>
          </div>
          <EditLink to={itemPath} />
        </CardHeader>
        {specifics.length > 0 ? (
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              {specifics.slice(0, 12).map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="truncate text-muted-foreground">{k}</dt>
                  <dd className="truncate">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        ) : null}
      </Card>

      {/* Title, description, price */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Listing</CardTitle>
            <CardDescription>Title, description and price, the same on every channel.</CardDescription>
          </div>
          <EditLink to={`${itemPath}/draft`} label="Open the composer" />
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="review-title">Title</Label>
            <Input id="review-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} disabled={approving || !!outcome} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="review-description">Description</Label>
              <Button type="button" variant="ghost" size="sm" onClick={() => void writeCopy()} disabled={listingCopy.isPending || approving || !!outcome}>
                {listingCopy.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
                Write it for me
              </Button>
            </div>
            <Textarea id="review-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={5} disabled={approving || !!outcome} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="review-price">Price (USD)</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input id="review-price" type="number" inputMode="decimal" min={0} step={0.01} value={price} onChange={(e) => setPrice(e.target.value)} className="w-36" disabled={approving || !!outcome} />
              {suggestedPrice != null && suggestedPrice > 0 ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setPrice(String(suggestedPrice))} disabled={approving || !!outcome}>
                  Use ${suggestedPrice.toFixed(2)}
                  <span className="ml-1 text-muted-foreground">
                    {suggestion.data?.soldBacked ? "from sold comps" : "from asks"}
                  </span>
                </Button>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Channels */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Channels</CardTitle>
            <CardDescription>Ticked channels run when you press Approve.</CardDescription>
          </div>
          <EditLink to="/dashboard/flipdesk/marketplaces" label="Marketplaces" />
        </CardHeader>
        <CardContent className="space-y-3">
          {channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channels are set up yet.</p>
          ) : null}
          <ul className="space-y-2">
            {channels.map((c) => {
              const canRun = c.mode !== "later" && connected(c);
              const checked = effectiveSelected.has(c.platform);
              return (
                <li key={c.platform} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    id={`ch-${c.platform}`}
                    checked={checked}
                    disabled={!canRun || approving || !!outcome}
                    onCheckedChange={(v) => {
                      const next = new Set(effectiveSelected);
                      if (v === true) next.add(c.platform);
                      else next.delete(c.platform);
                      setSelected(next);
                    }}
                  />
                  <Label htmlFor={`ch-${c.platform}`} className="flex flex-wrap items-center gap-2 font-normal">
                    <span className="font-medium">{c.label}</span>
                    {c.mode === "now" && canRun ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground"><Zap className="h-3 w-3" /> runs now</span>
                    ) : c.mode === "now" ? (
                      <span className="text-muted-foreground">connect it on Marketplaces first</span>
                    ) : c.mode === "queued" ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground"><Puzzle className="h-3 w-3" /> waits for your desktop browser</span>
                    ) : (
                      <span className="text-muted-foreground">once live</span>
                    )}
                  </Label>
                </li>
              );
            })}
          </ul>
          {plan.queued.length > 0 ? <p className="text-xs text-muted-foreground">{QUEUED_NOTICE}</p> : null}
        </CardContent>
      </Card>

      {/* Approve */}
      {!outcome ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            {blockers.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {blockers.map((b) => (
                  <li key={b.code} className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-destructive" />
                    <span>{b.message}</span>
                    {b.fix === "price" ? null : (
                      <Link to={itemPath} aria-label={`Edit details: ${b.message}`} className="underline underline-offset-2">Edit details</Link>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-sm text-muted-foreground">{approveSummary(plan)}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void approve()} disabled={approving || blockers.length > 0 || (plan.now.length === 0 && plan.queued.length === 0)}>
                {approving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                Approve
              </Button>
              <Button variant="ghost" onClick={() => navigate(itemPath)} disabled={approving}>
                Not now
              </Button>
              {firstPhotoMs ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" /> Timing from your first photo.
                </span>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Prefer the old path?{" "}
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() =>
            setReviewFlow.mutate(false, {
              onSuccess: () => toast.success("Back to the item page after intake. You can turn this on again from Add item."),
              onError: (err) => toastError(err, "Couldn't save that."),
            })
          }
        >
          Turn the review screen off
        </button>
        .
      </p>
    </div>
  );
}

function blockerSentence(list: ReviewBlocker[]): string {
  return list.map((b) => b.message).join(" ") || "Fix the blocked items first.";
}

function EditLink({ to, label = "Edit details" }: { to: string; label?: string }) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link to={to}>{label}</Link>
    </Button>
  );
}
