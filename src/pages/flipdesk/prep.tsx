import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Hammer,
  ChevronLeft,
  ChevronRight,
  SkipForward,
  Check,
  Circle,
  CircleCheck,
  Loader2,
  FileText,
  CircleDot,
  ExternalLink,
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
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { supabase } from "@/lib/supabase";
import { useItemsList, useItemFull } from "@/hooks/use-items-full";
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import { MeasurementForm } from "@/components/flipdesk/measurement-form";
import { SoldCompRecommendation } from "@/components/flipdesk/sold-comp-recommendation";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";
import { useGradeBandedPrice } from "@/hooks/use-ebay";
import { ebaySoldSearchUrl } from "@/lib/comps";
import { inferDepartment } from "@/lib/ebay-prefill";
import { rankOf, resolveStatus, factsOf } from "@/lib/workflow";
import { cn } from "@/lib/utils";
import type { ItemCategory } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";

const DRAFTED_RANK = rankOf("drafted");

interface PrepState {
  measurements: Record<string, number | string>;
  targetPrice: string;
  /**
   * US-2918: the item's size, editable here so the size-versus-measurements
   * note's one-click fix has something to write. It is saved with the rest of
   * the draft rather than immediately — prep is a batch surface, and a size
   * that changed while the seller was measuring should travel with the numbers
   * that changed it.
   */
  size: string;
}

export function FlipdeskPrepPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<PrepState | null>(null);
  const [saving, setSaving] = useState(false);

  // Shared items_full read — single source of truth across FlipDesk (US-419),
  // projected since US-2188: the queue needs display columns and measurements,
  // nothing here reads a description, a note or a comp set.
  const { data: items = [], isLoading } = useItemsList();

  // Items still in the prep phase (before drafted), oldest first. The shared
  // cache is ordered newest-first, so sort to oldest-first here.
  const queue = useMemo(
    () =>
      items
        .filter((it) => {
          const r = rankOf(it.status);
          return r >= 0 && r < DRAFTED_RANK;
        })
        .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")),
    [items],
  );

  const current: ItemListRow | undefined = queue[index];

  // Seed the editable draft whenever the current item changes.
  useEffect(() => {
    if (current) {
      setDraft({
        measurements:
          current.measurements && typeof current.measurements === "object"
            ? current.measurements
            : {},
        targetPrice:
          current.target_price == null ? "" : String(current.target_price),
        size: current.size ?? "",
      });
    } else {
      setDraft(null);
    }
  }, [current]);

  // US-2188: `ai_field_sources` is a detail-only column, so the AI-provenance
  // hints on the measurements card read it for the ONE item on screen instead
  // of keeping it on every row of the queue. It is a hint — the card renders
  // fine while this is still in flight.
  const { data: currentDetail } = useItemFull(current?.id);

  // Clamp index if the queue shrinks (e.g. an item advances out of prep).
  useEffect(() => {
    if (index > 0 && index >= queue.length) {
      setIndex(Math.max(0, queue.length - 1));
    }
  }, [queue.length, index]);

  async function persist(current: ItemListRow, d: PrepState) {
    const targetPrice =
      d.targetPrice.trim() === "" ? null : Number(d.targetPrice);
    const resolved = resolveStatus(current.status, current.status, {
      hasMeasurements: Object.keys(d.measurements).length > 0,
      hasRequiredPhotos: current.has_required_photos === true,
      hasTargetPrice: targetPrice != null,
      hasDraftListing: current.listing_id != null,
    });
    const { error } = await supabase
      .from("inventory_items")
      .update({
        measurements:
          Object.keys(d.measurements).length > 0 ? d.measurements : null,
        target_price: targetPrice,
        size: d.size.trim() === "" ? null : d.size.trim(),
        status: resolved,
      } as never)
      .eq("id", current.id);
    if (error) throw error;
  }

  async function saveAndAdvance(goToComposer = false) {
    if (!current || !draft) return;
    setSaving(true);
    try {
      await persist(current, draft);
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      if (goToComposer) {
        // `state.from` is what the item page's "Back to items" returns to;
        // without it the seller lands on the table's default tab, not Prep.
        navigate(`/dashboard/flipdesk/items/${current.id}/draft`, {
          state: { from: `${location.pathname}${location.search}` },
        });
        return;
      }
      toast.success(`Saved "${current.item_title}".`);
      // Stay on the same index — the saved item usually drops out of the
      // queue, sliding the next item into place.
      setIndex((i) => Math.min(i, Math.max(0, queue.length - 2)));
    } catch (err) {
      toastError(err, "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <LoadingRegion label="Loading prep queue" className="space-y-4 p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </LoadingRegion>
    );
  }

  if (queue.length === 0 || !current || !draft) {
    return (
      <div className="space-y-6">
        <PrepHeader queueLength={0} index={0} />
        <Card>
          <CardContent className="space-y-3 py-16 text-center">
            <CircleCheck className="mx-auto h-10 w-10 text-emerald-600 dark:text-emerald-400" />
            <div className="text-lg font-semibold">Prep queue is clear</div>
            <p className="text-sm text-muted-foreground">
              Every item has moved past prep. Time to draft and list.
            </p>
            <Button asChild>
              <Link to="/dashboard/flipdesk/listings?tab=to_list">
                Go to the To-List queue
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const facts = factsOf({
    ...current,
    measurements:
      Object.keys(draft.measurements).length > 0 ? draft.measurements : null,
    target_price:
      draft.targetPrice.trim() === "" ? null : Number(draft.targetPrice),
  });

  const steps = [
    { key: "photos", label: "Photos", done: facts.hasRequiredPhotos },
    { key: "measure", label: "Measured", done: facts.hasMeasurements },
    { key: "price", label: "Priced", done: facts.hasTargetPrice },
  ];

  return (
    <div className="space-y-5 pb-10">
      <PrepHeader queueLength={queue.length} index={index} />

      {/* Item header + nav */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="truncate">{current.item_title}</CardTitle>
              <CardDescription>
                {[current.brand, current.style, current.size]
                  .filter(Boolean)
                  .join(" · ") || "—"}
                {current.item_number ? ` · ${current.item_number}` : ""}
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0 || saving}
                aria-label="Previous item"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-2 text-xs tabular-nums text-muted-foreground">
                {index + 1} / {queue.length}
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() =>
                  setIndex((i) => Math.min(queue.length - 1, i + 1))
                }
                disabled={index >= queue.length - 1 || saving}
                aria-label="Next item"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {/* Step progress */}
          <div className="mt-2 flex flex-wrap gap-2">
            {steps.map((s) => (
              <span
                key={s.key}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                  s.done
                    ? "border-emerald-400/50 bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "border-muted-foreground/30 text-muted-foreground",
                )}
              >
                {s.done ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Circle className="h-3 w-3" />
                )}
                {s.label}
              </span>
            ))}
          </div>
        </CardHeader>
      </Card>

      {/* Step 1 — Photos */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <CircleDot className="h-4 w-4" />
            Photos
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PhotoUploader
            itemId={current.id}
            currentStatus={current.status}
            category={current.category as ItemCategory | null}
          />
        </CardContent>
      </Card>

      {/* Step 2 — Measurements */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <CircleDot className="h-4 w-4" />
            Measurements
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MeasurementForm
            category={current.category}
            brand={current.brand}
            values={draft.measurements}
            onChange={(m) => setDraft({ ...draft, measurements: m })}
            aiSources={currentDetail?.ai_field_sources ?? null}
            size={draft.size}
            gender={inferDepartment({
              title: current.item_title,
              brand: current.brand,
              size: draft.size,
              color: null,
              material: null,
              style: null,
              description: null,
              condition_notes: null,
              item_category: current.category,
            })}
            onSizeChange={(next) => setDraft({ ...draft, size: next })}
          />
        </CardContent>
      </Card>

      {/* Step 3 — Comp & price */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <CircleDot className="h-4 w-4" />
            Comp &amp; price
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="max-w-[200px] space-y-1">
            <Label htmlFor="prep-target-price">Target price</Label>
            <Input
              id="prep-target-price"
              type="number"
              value={draft.targetPrice}
              onChange={(e) =>
                setDraft({ ...draft, targetPrice: e.target.value })
              }
              placeholder="0.00"
            />
          </div>
          <PrepPriceRecommendation
            item={current}
            onApply={(dollars) =>
              setDraft((d) => (d ? { ...d, targetPrice: dollars.toFixed(2) } : d))
            }
          />
        </CardContent>
      </Card>

      {/* Action bar */}
      <div className="sticky bottom-0 -mx-6 border-t bg-card/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => setIndex((i) => Math.min(queue.length - 1, i + 1))}
            disabled={index >= queue.length - 1 || saving}
          >
            <SkipForward className="mr-2 h-4 w-4" />
            Skip
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => saveAndAdvance(true)}
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileText className="mr-2 h-4 w-4" />
              )}
              Save &amp; draft listing
            </Button>
            <Button onClick={() => saveAndAdvance(false)} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Save &amp; next
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// US-1477: live grade-banded price recommendation for the prep stage. Keyed on
// brand/title/size/grade so it works WITHOUT an eBay category (which isn't
// resolved until the composer), it replaces prep's old blank manual comp table
// — the composer still owns the full category-scoped live-comps pipeline
// downstream, so the manual comp_set was redundant dead-end data.
function PrepPriceRecommendation({
  item,
  onApply,
}: {
  item: ItemListRow;
  onApply: (dollars: number) => void;
}) {
  const query = useGradeBandedPrice({
    categoryId: null,
    q: item.item_title ?? undefined,
    brand: item.brand ?? undefined,
    size: item.size ?? undefined,
    grade: item.grade_value ?? null,
  });
  const rec = query.data ?? null;
  const hasRec = !!(rec && rec.sufficient && rec.recommendedCents != null);
  const soldUrl = ebaySoldSearchUrl({
    brand: item.brand,
    style: item.style,
    size: item.size,
    title: item.item_title,
  });

  return (
    <div className="space-y-2">
      <SoldCompRecommendation
        recommendation={rec}
        loading={query.isLoading}
        onApply={(dollars) => onApply(dollars)}
      />
      {!query.isLoading && !hasRec && (
        <p className="text-xs text-muted-foreground">
          Not enough live comp data to recommend a price yet — set a target
          above, or check recent sold listings. Live comps and a category-scoped
          recommendation appear in the listing composer.
        </p>
      )}
      <Button variant="outline" size="sm" asChild>
        <a href={soldUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="mr-2 h-3 w-3" />
          Search eBay sold
        </a>
      </Button>
    </div>
  );
}

function PrepHeader({
  queueLength,
  index,
}: {
  queueLength: number;
  index: number;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
          <Hammer className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            {queueLength > 0
              ? `Prepping ${queueLength} item${queueLength === 1 ? "" : "s"} — currently on item ${index + 1}.`
              : "Assembly-line prep for items that need photos, measurements, or pricing."}
          </p>
        </div>
        {queueLength > 0 && (
          <Badge variant="secondary" className="ml-auto">
            {queueLength} in queue
          </Badge>
        )}
      </div>
      <InventoryViewSwitcher current="prep" />
    </div>
  );
}

